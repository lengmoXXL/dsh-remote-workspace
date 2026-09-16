/**
 * Bilingual copy for the terminal panel.
 *
 * The Chinese dictionary is the key source; the English one is checked against
 * its key set, so a key added to one without the other fails the type check.
 *
 * @module dsh-remote-workspace/plugin/client/terminal/locales
 */

/** Locale namespace owned by this plugin's Web UI. */
export const NS = 'dsh-terminal'

/** This namespace's identifier, as the shell's locale and slot seats address it. */
export type TerminalNamespace = typeof NS

/** Simplified Chinese dictionary and key source. */
export const zh = {
  'type.label': '终端',
  'guide.title': '终端',
  'guide.description': '在会话的工作区目录打开一个 shell，远程工作区则在对应机器上打开',

  'status.opening': '正在打开终端…',
  'status.failed': '终端未能打开：{message}',
  'status.exited': '终端已退出（退出码 {code}）',
  'status.signalled': '终端已退出（信号 {signal}）',
  'status.disconnected': '连接已断开',

  'state.running': '运行中',
  'state.detached': '已断开',
  'state.exited': '已退出',

  'picker.title': '选择终端',
  'picker.description': '连接到一个已在运行的终端，或打开一个新的。',
  'picker.empty': '这个会话里还没有终端。',
  'picker.new': '新终端',
  'picker.opened': '已打开',
  'picker.close': '关闭终端 {label}',

  'note.fixedSize': '这台机器上的终端不支持调整大小',

  'action.end': '结束终端',
  'action.restart': '重新打开',
  'action.newTab': '新建终端',

  loading: '正在读取…',
  cancel: '取消',
  close: '关闭',
  requestFailed: '请求失败（{status}）',
}

/** Every key this namespace owns. */
export type TerminalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'type.label': 'Terminal',
  'guide.title': 'Terminal',
  'guide.description': 'Open a shell in the session workspace — on the machine that owns it when the workspace is remote',

  'status.opening': 'Opening the terminal…',
  'status.failed': 'The terminal could not be opened: {message}',
  'status.exited': 'The terminal exited (code {code})',
  'status.signalled': 'The terminal exited (signal {signal})',
  'status.disconnected': 'The connection dropped',

  'state.running': 'running',
  'state.detached': 'detached',
  'state.exited': 'exited',

  'picker.title': 'Choose a terminal',
  'picker.description': 'Attach to a terminal that is already running, or open a new one.',
  'picker.empty': 'No terminals in this session yet.',
  'picker.new': 'New terminal',
  'picker.opened': 'Open in another tab',
  'picker.close': 'Close terminal {label}',

  'note.fixedSize': 'Terminals on this machine cannot be resized',

  'action.end': 'End terminal',
  'action.restart': 'Restart',
  'action.newTab': 'New terminal',

  loading: 'Loading…',
  cancel: 'Cancel',
  close: 'Close',
  requestFailed: 'Request failed with {status}',
} satisfies Record<TerminalKey, string>
