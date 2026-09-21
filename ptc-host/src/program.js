/**
 * The JavaScript half of the program host.
 *
 * The Rust host owns the control channel, the V8 isolate and the frame loop;
 * this file owns everything the model-written program is allowed to see: the
 * binding namespaces, the console shim, the output ledger, and the flat
 * lossless-JSON codec the DeepSeek Harness PTC process protocol carries values
 * in.
 *
 * It is deliberately not Node. The program runs in a bare V8 context and
 * reaches its machine only through the bindings its caller declared: there is
 * no process, no require, no module loader, and no timer.
 */

(function () {
  'use strict';

  // The host function Rust installs before this script runs. Captured now so a
  // program that reassigns the globals cannot sever the channel underneath it.
  var write = globalThis.__dsh_send;
  var parse = JSON.parse;
  var stringify = JSON.stringify;

  function send(message) {
    write(stringify(message));
  }

  // ------------------------------------------------------------ frame routing

  var replies = new Map();
  var bootResolve = null;
  var bootSettled = false;
  var bootFrame = null;

  function settleBoot(text) {
    if (bootSettled) return;
    bootSettled = true;
    bootFrame = text;
    if (bootResolve !== null) {
      var resolve = bootResolve;
      bootResolve = null;
      resolve(text);
    }
  }

  function deliverReply(message) {
    var entry = replies.get(message.id);
    if (entry === undefined) return;
    replies.delete(message.id);
    if (message.ok === true) {
      var value = unflatten(message.value);
      if (value === undefined) entry.reject(new Error('binding resolution must be lossless JSON'));
      else entry.resolve(value);
    } else {
      entry.reject(new Error(typeof message.message === 'string' ? message.message : 'binding call failed'));
    }
  }

  // Rust hands every frame it reads to this function. Rust holds its own
  // reference, so reassigning the global does not redirect delivery.
  globalThis.__dsh_onFrame = function (text) {
    var message;
    try {
      message = parse(text);
    } catch (error) {
      return;
    }
    if (message !== null && typeof message === 'object' && message.type === 'reply') {
      deliverReply(message);
      return;
    }
    settleBoot(text);
  };

  // Rust calls this when the channel closed before the program ended, so the
  // awaiting bootstrap does not hang on a frame that will never arrive.
  globalThis.__dsh_onClose = function () {
    settleBoot(null);
  };

  function nextFrame() {
    if (bootSettled) {
      var text = bootFrame;
      bootFrame = null;
      return Promise.resolve(text);
    }
    return new Promise(function (resolve) {
      bootResolve = resolve;
    });
  }

  // --------------------------------------------------------------- value codec
  //
  // A lossless JSON value crosses as a flat pre-order token stream: scalars
  // stand for themselves, and a container is a marker followed by its children
  // in order. Flattening validates as it goes, so one pass both rejects a value
  // that cannot cross and produces the wire form.

  function flatten(root) {
    var wire = [];
    var active = new Set();
    var stack = [{ value: root }];
    while (stack.length > 0) {
      var task = stack.pop();
      if (task.leave !== undefined) {
        active.delete(task.leave);
        continue;
      }
      var value = task.value;
      if (value === null || typeof value === 'boolean' || typeof value === 'string') {
        wire.push(value);
        continue;
      }
      if (typeof value === 'number') {
        if (!Number.isFinite(value) || Object.is(value, -0)) return undefined;
        wire.push(value);
        continue;
      }
      if (typeof value !== 'object') return undefined;
      if (active.has(value)) return undefined;
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
        var length = value.length;
        if (Reflect.ownKeys(value).length !== length + 1) return undefined;
        wire.push({ kind: 'array', length: length });
        active.add(value);
        stack.push({ leave: value });
        for (var index = length - 1; index >= 0; index--) {
          if (!Object.prototype.hasOwnProperty.call(value, index)) return undefined;
          stack.push({ value: value[index] });
        }
        continue;
      }
      var prototype = Object.getPrototypeOf(value);
      if (prototype !== null && prototype !== Object.prototype) return undefined;
      var keys = Reflect.ownKeys(value);
      for (var keyIndex = 0; keyIndex < keys.length; keyIndex++) {
        if (typeof keys[keyIndex] !== 'string') return undefined;
        if (!Object.prototype.propertyIsEnumerable.call(value, keys[keyIndex])) return undefined;
      }
      wire.push({ kind: 'object', keys: keys });
      active.add(value);
      stack.push({ leave: value });
      for (var back = keys.length - 1; back >= 0; back--) stack.push({ value: value[keys[back]] });
    }
    return wire;
  }

  function containerMarker(token) {
    if (token === null || typeof token !== 'object' || Array.isArray(token)) return undefined;
    var prototype = Object.getPrototypeOf(token);
    if (prototype !== null && prototype !== Object.prototype) return undefined;
    var keys = Reflect.ownKeys(token);
    if (token.kind === 'array') {
      if (keys.length !== 2 || keys.indexOf('kind') < 0 || keys.indexOf('length') < 0) return undefined;
      var length = token.length;
      if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0) return undefined;
      return { kind: 'array', length: length };
    }
    if (token.kind === 'object') {
      if (keys.length !== 2 || keys.indexOf('kind') < 0 || keys.indexOf('keys') < 0) return undefined;
      var objectKeys = token.keys;
      if (!Array.isArray(objectKeys)) return undefined;
      if (Reflect.ownKeys(objectKeys).length !== objectKeys.length + 1) return undefined;
      var seen = new Set();
      var normalized = [];
      for (var index = 0; index < objectKeys.length; index++) {
        var key = objectKeys[index];
        if (typeof key !== 'string' || seen.has(key)) return undefined;
        seen.add(key);
        normalized.push(key);
      }
      return { kind: 'object', keys: normalized };
    }
    return undefined;
  }

  function unflatten(input) {
    if (!Array.isArray(input) || input.length === 0) return undefined;
    var frames = [];
    var root;
    var assigned = false;
    for (var index = 0; index < input.length; index++) {
      var token = input[index];
      var value;
      var frame;
      if (token === null || typeof token === 'boolean' || typeof token === 'string') {
        value = token;
      } else if (typeof token === 'number') {
        if (!Number.isFinite(token) || Object.is(token, -0)) return undefined;
        value = token;
      } else {
        var marker = containerMarker(token);
        if (marker === undefined) return undefined;
        var remaining = input.length - index - 1;
        if (marker.kind === 'array') {
          if (marker.length > remaining) return undefined;
          value = [];
          if (marker.length > 0) frame = { kind: 'array', target: value, length: marker.length, index: 0 };
        } else {
          if (marker.keys.length > remaining) return undefined;
          value = {};
          if (marker.keys.length > 0) frame = { kind: 'object', target: value, keys: marker.keys, index: 0 };
        }
      }
      var parent = frames.length > 0 ? frames[frames.length - 1] : undefined;
      if (parent === undefined) {
        if (assigned) return undefined;
        root = value;
        assigned = true;
      } else if (parent.index < (parent.kind === 'array' ? parent.length : parent.keys.length)) {
        if (parent.kind === 'array') parent.target.push(value);
        else Object.defineProperty(parent.target, parent.keys[parent.index], {
          value: value, enumerable: true, configurable: true, writable: true,
        });
        parent.index += 1;
      } else {
        return undefined;
      }
      if (frame !== undefined) frames.push(frame);
      while (frames.length > 0) {
        var current = frames[frames.length - 1];
        if (current.index < (current.kind === 'array' ? current.length : current.keys.length)) break;
        frames.pop();
      }
    }
    return frames.length === 0 ? root : undefined;
  }

  // -------------------------------------------------------------- output ledger
  //
  // Every captured line is charged against the same combined budget the host
  // accounts for, as the JSON-escaped bytes its array element would take.

  function jsonStringBytesUpTo(text, limit) {
    if (limit < 2) return undefined;
    var bytes = 2;
    for (var index = 0; index < text.length; index++) {
      var code = text.charCodeAt(index);
      var cost;
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        var low = text.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          bytes += 4;
          index += 1;
          if (bytes > limit) return undefined;
          continue;
        }
      }
      if (code >= 0xd800 && code <= 0xdfff) cost = 6;
      else if (code === 8 || code === 9 || code === 10 || code === 12 || code === 13 || code === 34 || code === 92) cost = 2;
      else if (code < 32) cost = 6;
      else if (code < 0x80) cost = 1;
      else if (code < 0x800) cost = 2;
      else cost = 3;
      bytes += cost;
      if (bytes > limit) return undefined;
    }
    return bytes;
  }

  function jsonStringBytes(text) {
    return jsonStringBytesUpTo(text, Infinity);
  }

  function truncateJsonString(text, limit) {
    if (limit < 2) return '';
    var bytes = 2;
    var end = 0;
    for (var index = 0; index < text.length;) {
      var code = text.charCodeAt(index);
      var width = 1;
      var cost;
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        var low = text.charCodeAt(index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          width = 2;
          cost = 4;
        }
      }
      if (width === 1) {
        if (code >= 0xd800 && code <= 0xdfff) cost = 6;
        else if (code === 8 || code === 9 || code === 10 || code === 12 || code === 13 || code === 34 || code === 92) cost = 2;
        else if (code < 32) cost = 6;
        else if (code < 0x80) cost = 1;
        else if (code < 0x800) cost = 2;
        else cost = 3;
      }
      if (bytes + cost > limit) break;
      bytes += cost;
      index += width;
      end = index;
    }
    return text.slice(0, end);
  }

  function Ledger(maxBytes, sink, onLimit) {
    this.bytes = 2;
    this.entries = 0;
    this.truncated = false;
    this.maxBytes = maxBytes;
    this.sink = sink;
    this.onLimit = onLimit;
  }

  Ledger.prototype.push = function (text) {
    if (this.truncated) return;
    var separator = this.entries > 0 ? 1 : 0;
    var available = this.maxBytes - this.bytes - separator;
    var bytes = jsonStringBytesUpTo(text, available);
    if (bytes === undefined) {
      this.truncated = true;
      var prefix = truncateJsonString(text, available);
      if (prefix.length > 0) {
        this.bytes += jsonStringBytes(prefix) + separator;
        this.entries += 1;
        this.sink(prefix);
      }
      this.onLimit();
      return;
    }
    this.bytes += bytes + separator;
    this.entries += 1;
    this.sink(text);
  };

  Ledger.prototype.remaining = function () {
    return this.maxBytes - this.bytes;
  };

  // ------------------------------------------------------------------ console
  //
  // The program gets five leveled methods and no more, rendered close to
  // Node's console.inspect formatting so a model recognizes its own output.

  function inspect(value, depth) {
    if (value === null) return 'null';
    if (value === undefined) return 'undefined';
    var type = typeof value;
    if (type === 'string') return JSON.stringify(value);
    if (type === 'number' || type === 'boolean') return String(value);
    if (type === 'bigint') return String(value) + 'n';
    if (type === 'symbol') return String(value);
    if (type === 'function') return '[Function: ' + (value.name || 'anonymous') + ']';
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (value instanceof Error) return value.name + ': ' + value.message;
    if (depth <= 0) return Array.isArray(value) ? '[Array]' : '[Object]';
    if (Array.isArray(value)) {
      var shown = Math.min(value.length, 100);
      var items = [];
      for (var index = 0; index < shown; index++) items.push(inspect(value[index], depth - 1));
      if (value.length > shown) items.push('... ' + (value.length - shown) + ' more items');
      return items.length === 0 ? '[]' : '[ ' + items.join(', ') + ' ]';
    }
    if (value instanceof Map) return 'Map(' + value.size + ')';
    if (value instanceof Set) return 'Set(' + value.size + ')';
    var keys = Object.keys(value);
    var parts = [];
    for (var keyIndex = 0; keyIndex < keys.length; keyIndex++) {
      parts.push(keys[keyIndex] + ': ' + inspect(value[keys[keyIndex]], depth - 1));
    }
    return parts.length === 0 ? '{}' : '{ ' + parts.join(', ') + ' }';
  }

  function makeConsole(ledger) {
    var levels = ['log', 'info', 'warn', 'error', 'debug'];
    var shim = Object.create(null);
    var collect = function (level) {
      shim[level] = function () {
        var parts = [];
        for (var argument = 0; argument < arguments.length; argument++) {
          var value = arguments[argument];
          parts.push(typeof value === 'string' ? value : inspect(value, 4));
        }
        ledger.push(parts.join(' '));
      };
    };
    for (var index = 0; index < levels.length; index++) collect(levels[index]);
    return shim;
  }

  // --------------------------------------------------------------- bindings

  function detailOf(error) {
    try {
      return error instanceof Error ? error.message : String(error);
    } catch (ignored) {
      return 'binding call failed';
    }
  }

  function makeErrorClass(descriptor) {
    class BindingCallError extends Error {
      constructor(memberName, message) {
        super(message);
        Object.defineProperty(this, 'name', {
          value: descriptor.name, enumerable: true, configurable: true, writable: true,
        });
        Object.defineProperty(this, descriptor.memberNameProperty, {
          value: memberName, enumerable: true, configurable: true, writable: true,
        });
      }
    }
    return BindingCallError;
  }

  function bindingFailure(errorClass, memberName, message) {
    if (errorClass === undefined) return new Error(message);
    return new errorClass(memberName, message);
  }

  function makeNamespace(namespace, allocate, errorClass) {
    var target = Object.create(null);
    var define = function (name) {
      Object.defineProperty(target, name, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: function (args) {
          var wire = flatten(args);
          if (wire === undefined) {
            return Promise.reject(bindingFailure(errorClass, name, 'binding arguments must be lossless JSON'));
          }
          return new Promise(function (resolve, reject) {
            var id = allocate();
            replies.set(id, {
              resolve: resolve,
              reject: function (error) {
                reject(bindingFailure(errorClass, name, detailOf(error)));
              },
            });
            try {
              send({ type: 'call', id: id, global: namespace.global, name: name, args: wire });
            } catch (error) {
              replies.delete(id);
              reject(bindingFailure(errorClass, name, 'binding arguments must be structured-cloneable: ' + detailOf(error)));
            }
          });
        },
      });
    };
    for (var index = 0; index < namespace.names.length; index++) define(namespace.names[index]);
    return target;
  }

  // ------------------------------------------------------------- completion

  function wireBytes(wire) {
    var bytes = 0;
    for (var index = 0; index < wire.length; index++) {
      var token = wire[index];
      if (token === null) { bytes += 4; continue; }
      if (typeof token === 'boolean') { bytes += token ? 4 : 5; continue; }
      if (typeof token === 'number') { bytes += String(token).length; continue; }
      if (typeof token === 'string') { bytes += jsonStringBytes(token); continue; }
      bytes += 2;
      if (token.kind === 'object') {
        for (var keyIndex = 0; keyIndex < token.keys.length; keyIndex++) {
          bytes += jsonStringBytes(token.keys[keyIndex]) + 1;
        }
      }
    }
    return bytes;
  }

  function overflow(maxOutputBytes) {
    return { error: { kind: 'output-limit', message: 'outer output exceeded ' + maxOutputBytes + ' bytes' } };
  }

  function failure(kind, message, remaining, maxOutputBytes) {
    if (jsonStringBytesUpTo(message, remaining) === undefined) return overflow(maxOutputBytes);
    return { error: { kind: kind, message: message } };
  }

  function completion(value, remaining, maxOutputBytes) {
    if (value === undefined) return {};
    var wire = flatten(value);
    if (wire === undefined) {
      return failure('invalid-output', 'program completion must be lossless JSON', remaining, maxOutputBytes);
    }
    if (wireBytes(wire) > remaining) return overflow(maxOutputBytes);
    return { value: wire };
  }

  function exception(error, remaining, maxOutputBytes) {
    var message;
    try {
      var detail = error instanceof Error
        ? (typeof error.stack === 'string' ? error.stack : error.message)
        : error;
      message = typeof detail === 'string' ? detail : String(detail);
    } catch (ignored) {
      message = 'program threw an unrenderable value';
    }
    return failure('exception', message, remaining, maxOutputBytes);
  }

  // ------------------------------------------------------------------- program

  async function runProgram(data) {
    var ledger = new Ledger(
      data.maxOutputBytes,
      function (text) { send({ type: 'log', text: text }); },
      function () { send({ type: 'output-limit' }); },
    );
    var consoleShim = makeConsole(ledger);
    var nextId = 1;
    var allocate = function () {
      var id = nextId;
      nextId += 1;
      return id;
    };
    var namespaces = [];
    var errorClasses = new Map();
    var index;
    for (index = 0; index < data.namespaces.length; index++) {
      var namespace = data.namespaces[index];
      var errorClass = namespace.errorClass === undefined ? undefined : makeErrorClass(namespace.errorClass);
      if (errorClass !== undefined) errorClasses.set(namespace.global, errorClass);
      namespaces.push(makeNamespace(namespace, allocate, errorClass));
    }
    var parameters = [];
    var values = [];
    for (index = 0; index < data.namespaces.length; index++) parameters.push(data.namespaces[index].global);
    for (index = 0; index < data.namespaces.length; index++) {
      if (data.namespaces[index].errorClass !== undefined) parameters.push(data.namespaces[index].errorClass.name);
    }
    for (index = 0; index < namespaces.length; index++) values.push(namespaces[index]);
    for (index = 0; index < data.namespaces.length; index++) {
      if (data.namespaces[index].errorClass !== undefined) values.push(errorClasses.get(data.namespaces[index].global));
    }
    parameters.push('console');
    values.push(consoleShim);

    var done;
    try {
      var AsyncFunction = (async function () {}).constructor;
      var fragments = parameters.slice();
      fragments.push('"use strict";' + String.fromCharCode(10) + data.code);
      var body = new AsyncFunction(...fragments);
      done = { type: 'done', ...completion(await body(...values), ledger.remaining(), data.maxOutputBytes) };
    } catch (error) {
      done = { type: 'done', ...exception(error, ledger.remaining(), data.maxOutputBytes) };
    }
    send(done);
  }

  async function main() {
    send({ type: 'ready' });
    var text = await nextFrame();
    if (text === null) return;
    var boot = parse(text);
    if (boot === null || typeof boot !== 'object' || boot.type !== 'boot'
      || boot.data === null || typeof boot.data !== 'object') {
      throw new Error('expected program boot frame');
    }
    await runProgram(boot.data);
  }

  // Rust polls this promise: while it is pending, the program is waiting for a
  // binding reply the host has not sent yet.
  globalThis.__dsh_root = main().catch(function (error) {
    var message;
    try {
      message = error instanceof Error && typeof error.stack === 'string' ? error.stack : String(error);
    } catch (ignored) {
      message = 'program host failed';
    }
    try {
      send({ type: 'done', error: { kind: 'exception', message: message } });
    } catch (ignored) {
      // The channel is already gone; there is nothing left to report on.
    }
  });
})();
