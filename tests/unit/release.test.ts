/**
 * The release resolver is where a machine's platform becomes bytes that will
 * be executed there, so its cases are about the ways that can go wrong: naming
 * an archive no release carries, accepting an archive whose hash does not match
 * the release's own sums file, unpacking one that holds no agent, and reading a
 * download that answered with something that is not an archive at all.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import type { AgentFetcher } from '../../src/remote/agent/release.ts'
import {
  PTC_HOST_MEMBER,
  agentArchiveUrl,
  agentAssetName,
  agentSumsUrl,
  ptcHostAssetName,
  resolveAgentBinary,
} from '../../src/remote/agent/release.ts'

const VERSION = '0.0.2'
const ASSET = 'dsh-remote-agent-linux-x86_64'
const ARCHIVE = `${ASSET}.tar.gz`
const BINARY = Buffer.from('the binary bytes')
const ARCHIVE_URL = agentArchiveUrl(VERSION, ASSET)
const SUMS_URL = agentSumsUrl(VERSION)

/** One request a scripted fetcher answered. */
interface SeenRequest {
  readonly url: string
}

/** A fresh cache directory for one case. */
async function cacheDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'drw-release-'))
}

/** A checksum line for one release file. */
function sumsFor(fileName: string, digest: string): Buffer {
  return Buffer.from(`${digest}  ${fileName}\n`)
}

/** The digest of the fixture archive. */
function archiveDigest(archive: Buffer): string {
  return createHash('sha256').update(archive).digest('hex')
}

/** One tar header block. */
function tarHeader(name: string, size: number, type: string): Buffer {
  const block = Buffer.alloc(512)
  block.write(name, 0, 'utf8')
  block.write('0000644\0', 100)
  block.write('0000000\0', 108)
  block.write('0000000\0', 116)
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
  block.write('00000000000\0', 136)
  // The checksum is the header's own bytes summed with this field read as
  // spaces; nothing here validates it, but a real tar writes one.
  block.write('        ', 148)
  block.write(type, 156)
  block.write('ustar\0', 257)
  block.write('00', 263)
  let sum = 0
  for (const byte of block) sum += byte
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148)
  return block
}

/** A gzipped tar holding the given records, padded the way tar pads them. */
function tarball(entries: readonly { name: string; body: Buffer; type?: string }[]): Buffer {
  const padded = (body: Buffer): Buffer =>
    Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)])
  const records = entries.flatMap(entry => [
    tarHeader(entry.name, entry.body.length, entry.type ?? '0'),
    padded(entry.body),
  ])
  return gzipSync(Buffer.concat([...records, Buffer.alloc(1024)]))
}

/** The archive a release of this repository publishes for the fixture asset. */
function releaseArchive(member = 'dsh-remote-agent', body = BINARY): Buffer {
  return tarball([{ name: member, body }])
}

/**
 * A scripted fetcher: whichever release files the caller supplies.
 * @param bodies - per-URL bodies; an absent entry fails the request.
 * @returns the fetcher and the requests it saw.
 */
function scriptedFetch(bodies: Readonly<Record<string, Buffer | undefined>>): {
  fetch: AgentFetcher
  seen: SeenRequest[]
} {
  const seen: SeenRequest[] = []
  return {
    seen,
    fetch: (url) => {
      seen.push({ url })
      const body = bodies[url]
      return body === undefined
        ? Promise.reject(new Error(`unscripted request to ${url}`))
        : Promise.resolve(body)
    },
  }
}

test('each reported platform maps to its release asset', () => {
  assert.equal(agentAssetName('Linux', 'x86_64'), 'dsh-remote-agent-linux-x86_64')
  assert.equal(agentAssetName('linux', 'amd64'), 'dsh-remote-agent-linux-x86_64')
  assert.equal(agentAssetName('Darwin', 'aarch64'), 'dsh-remote-agent-darwin-aarch64')
  assert.equal(agentAssetName('darwin', 'arm64'), 'dsh-remote-agent-darwin-aarch64')
  assert.equal(agentAssetName(' Linux ', ' AMD64 '), 'dsh-remote-agent-linux-x86_64')
  assert.equal(ptcHostAssetName('Linux', 'x86_64'), 'dsh-ptc-host-linux-x86_64')
  assert.equal(ptcHostAssetName('Darwin', 'arm64'), 'dsh-ptc-host-darwin-aarch64')
})

test('the PTC program host is fetched as its own asset and member', async () => {
  const worker = Buffer.from('the worker bytes')
  const archive = releaseArchive(PTC_HOST_MEMBER, worker)
  const digest = archiveDigest(archive)
  const asset = ptcHostAssetName('Linux', 'x86_64')
  const scripted = scriptedFetch({
    [agentArchiveUrl(VERSION, asset)]: archive,
    [agentSumsUrl(VERSION)]: sumsFor(`${asset}.tar.gz`, digest),
  })
  const dir = await cacheDir()

  try {
    const binary = await resolveAgentBinary({
      version: VERSION,
      assetName: asset,
      member: PTC_HOST_MEMBER,
      cacheDir: dir,
      fetch: scripted.fetch,
    })
    assert.deepEqual(binary, worker)
    assert.deepEqual(await readFile(join(dir, VERSION, asset)), worker)
    assert.deepEqual(scripted.seen.map(request => request.url), [
      agentArchiveUrl(VERSION, asset),
      agentSumsUrl(VERSION),
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a platform with no release fails naming what the machine reported', () => {
  assert.throws(() => agentAssetName('FreeBSD', 'x86_64'), /FreeBSD/)
  assert.throws(() => agentAssetName('Linux', 'riscv64'), /riscv64/)
})

test('a version and asset build the release download address, not an API call', () => {
  assert.equal(
    agentArchiveUrl('0.0.2', ASSET),
    'https://github.com/lengmoXXL/dsh-remote-workspace/releases/download/v0.0.2/'
    + 'dsh-remote-agent-linux-x86_64.tar.gz',
  )
  assert.equal(
    agentSumsUrl('0.0.2'),
    'https://github.com/lengmoXXL/dsh-remote-workspace/releases/download/v0.0.2/SHA256SUMS',
  )
  assert.equal(ARCHIVE_URL.includes('api.github.com'), false)
})

test('a cached binary is returned without touching the network', async () => {
  const dir = await cacheDir()
  try {
    await mkdir(join(dir, VERSION), { recursive: true })
    await writeFile(join(dir, VERSION, ASSET), BINARY)
    const result = await resolveAgentBinary({
      version: VERSION,
      assetName: ASSET,
      cacheDir: dir,
      fetch: () => Promise.reject(new Error('the cache must short-circuit the download')),
    })
    assert.deepEqual(result, BINARY)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a verified archive is unpacked and its binary cached at the versioned path', async () => {
  const dir = await cacheDir()
  try {
    const archive = releaseArchive()
    const { fetch, seen } = scriptedFetch({
      [ARCHIVE_URL]: archive,
      [SUMS_URL]: sumsFor(ARCHIVE, archiveDigest(archive)),
    })
    const result = await resolveAgentBinary({ version: VERSION, assetName: ASSET, cacheDir: dir, fetch })

    // The archive is what is downloaded; the binary is what the caller gets and
    // what the cache holds, because the upload to the machine sends it verbatim.
    assert.deepEqual(result, BINARY)
    assert.deepEqual(await readFile(join(dir, VERSION, ASSET)), BINARY)
    assert.deepEqual(seen.map(request => request.url), [ARCHIVE_URL, SUMS_URL])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('reports whether the bytes come from the cache or the network', async () => {
  const dir = await cacheDir()
  try {
    const sources: string[] = []
    const archive = releaseArchive()
    const { fetch } = scriptedFetch({
      [ARCHIVE_URL]: archive,
      [SUMS_URL]: sumsFor(ARCHIVE, archiveDigest(archive)),
    })
    await resolveAgentBinary({
      version: VERSION,
      assetName: ASSET,
      cacheDir: dir,
      fetch,
      onSource: source => { sources.push(source) },
    })
    // The second call is answered from the cache, so it must not reach the
    // network at all — which is exactly what a caller showing progress wants
    // to be able to say.
    await resolveAgentBinary({
      version: VERSION,
      assetName: ASSET,
      cacheDir: dir,
      fetch: () => Promise.reject(new Error('the cache must short-circuit the download')),
      onSource: source => { sources.push(source) },
    })
    assert.deepEqual(sources, ['network', 'cache'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a metadata record ahead of the agent does not hide it', async () => {
  const dir = await cacheDir()
  try {
    // A PAX header, which a tar writes ahead of the file it describes.
    const archive = tarball([
      { name: '././@PaxHeader', body: Buffer.from('30 mtime=0\n'), type: 'x' },
      { name: './dsh-remote-agent', body: BINARY },
    ])
    const { fetch } = scriptedFetch({
      [ARCHIVE_URL]: archive,
      [SUMS_URL]: sumsFor(ARCHIVE, archiveDigest(archive)),
    })
    const result = await resolveAgentBinary({ version: VERSION, assetName: ASSET, cacheDir: dir, fetch })
    assert.deepEqual(result, BINARY)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a checksum mismatch refuses the archive and names the download', async () => {
  const dir = await cacheDir()
  try {
    const wrong = createHash('sha256').update('something else').digest('hex')
    const { fetch } = scriptedFetch({
      [ARCHIVE_URL]: releaseArchive(),
      [SUMS_URL]: sumsFor(ARCHIVE, wrong),
    })
    await assert.rejects(
      () => resolveAgentBinary({ version: VERSION, assetName: ASSET, cacheDir: dir, fetch }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.match(message, /SHA-256 check/)
        assert.equal(message.includes(ARCHIVE_URL), true)
        return true
      },
    )
    // A refused download must leave no cache entry behind.
    await assert.rejects(() => readFile(join(dir, VERSION, ASSET)), /ENOENT/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed archive download names the URL it could not read', async () => {
  const dir = await cacheDir()
  try {
    await assert.rejects(
      () => resolveAgentBinary({
        version: VERSION,
        assetName: ASSET,
        cacheDir: dir,
        fetch: (url) => {
          if (url === ARCHIVE_URL) return Promise.reject(new Error('HTTP 404'))
          return Promise.resolve(sumsFor(ARCHIVE, 'a'.repeat(64)))
        },
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.equal(message.includes(`downloading ${ARCHIVE_URL} failed`), true)
        assert.match(message, /HTTP 404/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a failed sums download names the URL it could not read', async () => {
  const dir = await cacheDir()
  try {
    await assert.rejects(
      () => resolveAgentBinary({
        version: VERSION,
        assetName: ASSET,
        cacheDir: dir,
        fetch: (url) => {
          if (url === SUMS_URL) return Promise.reject(new Error('socket hang up'))
          return Promise.resolve(releaseArchive())
        },
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.equal(message.includes(`downloading ${SUMS_URL} failed`), true)
        assert.match(message, /socket hang up/)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('a sums file that names no such archive is refused', async () => {
  const dir = await cacheDir()
  try {
    const { fetch } = scriptedFetch({
      [ARCHIVE_URL]: releaseArchive(),
      [SUMS_URL]: sumsFor('dsh-remote-agent-other-x86_64.tar.gz', 'a'.repeat(64)),
    })
    await assert.rejects(
      () => resolveAgentBinary({ version: VERSION, assetName: ASSET, cacheDir: dir, fetch }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.equal(message.includes(SUMS_URL), true)
        assert.equal(message.includes(ARCHIVE), true)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an archive that carries no agent is refused by name', async () => {
  const dir = await cacheDir()
  try {
    const archive = tarball([{ name: 'dsh-remote-agent-other', body: BINARY }])
    const { fetch } = scriptedFetch({
      [ARCHIVE_URL]: archive,
      [SUMS_URL]: sumsFor(ARCHIVE, archiveDigest(archive)),
    })
    await assert.rejects(
      () => resolveAgentBinary({ version: VERSION, assetName: ASSET, cacheDir: dir, fetch }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.equal(message.includes(ARCHIVE_URL), true)
        assert.equal(message.includes('dsh-remote-agent'), true)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('an answer that is not a gzipped tar is refused by name', async () => {
  const dir = await cacheDir()
  try {
    const page = Buffer.from('<html>not found</html>')
    const { fetch } = scriptedFetch({
      [ARCHIVE_URL]: page,
      [SUMS_URL]: sumsFor(ARCHIVE, archiveDigest(page)),
    })
    await assert.rejects(
      () => resolveAgentBinary({ version: VERSION, assetName: ASSET, cacheDir: dir, fetch }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error)
        assert.equal(message.includes(`${ARCHIVE_URL} is not a gzipped tar archive`), true)
        return true
      },
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
