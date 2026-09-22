/**
 * Resolve the agent binary for one machine's platform.
 *
 * The agent is a static Rust binary published on GitHub Releases inside a
 * per-platform `.tar.gz`, so "install the agent" reduces to naming the right
 * archive for `uname` and caching the binary it holds. The cache is keyed by
 * version and asset, which is what makes a version bump a fresh download and a
 * second machine of the same platform a cache hit.
 *
 * The archive is read from the release's own download address — the URL a
 * browser would follow, built from the tag and the asset name — so nothing here
 * calls the GitHub API: no release metadata, no asset listing, no media type to
 * negotiate, and no anonymous rate limit to spend. A release that carries no
 * such archive answers 404 and is reported with the address that failed.
 *
 * Every download is verified against the release's `SHA256SUMS` before it is
 * unpacked and cached: the bytes are executed on a remote machine, so a
 * truncated or substituted archive must fail here rather than at exec time
 * there.
 *
 * @module dsh-remote-workspace/remote/agent/release
 */

import { createHash, randomUUID } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** Repository whose releases carry the agent binaries. */
const RELEASE_REPOSITORY = 'lengmoXXL/dsh-remote-workspace'

/** Address one release file is downloaded from, by tag and file name. */
const DOWNLOAD_ROOT = `https://github.com/${RELEASE_REPOSITORY}/releases/download`

/** The regular file every release archive carries: the agent itself. */
const AGENT_MEMBER = 'dsh-remote-agent'

/**
 * The native PTC program host the same release carries.
 *
 * A node that has no Node runtime runs this in place of the interpreter the
 * harness's PTC provider would otherwise spawn there, so it ships as its own
 * archive and is fetched only by machines that actually run a program.
 */
export const PTC_HOST_MEMBER = 'dsh-ptc-host'

/** The sums file every release carries beside its archives. */
const SUMS_FILE = 'SHA256SUMS'

/** Bytes one tar header block holds. */
const TAR_BLOCK = 512

/** Platform names `uname -s` reports, and the asset token each maps to. */
const PLATFORMS: Readonly<Record<string, string>> = {
  linux: 'linux',
  darwin: 'darwin',
}

/**
 * Architecture names `uname -m` reports, and the asset token each maps to.
 *
 * x86_64 only: the release carries no other build, so a machine this plugin
 * cannot serve is refused by name before anything is downloaded.
 */
const ARCHITECTURES: Readonly<Record<string, string>> = {
  x86_64: 'x86_64',
  amd64: 'x86_64',
}

/** Downloads one URL; injectable so tests need no network. */
export type AgentFetcher = (url: string) => Promise<Buffer>

/** Options {@link resolveAgentBinary} reads. */
export interface AgentBinaryOptions {
  /** Agent build to fetch, e.g. `0.0.2`. */
  readonly version: string
  /** Release asset for the machine's platform, from {@link agentAssetName}. */
  readonly assetName: string
  /**
   * Regular file to unpack from the archive. Defaults to the agent itself;
   * {@link PTC_HOST_MEMBER} names the PTC program host.
   */
  readonly member?: string
  /** Host directory the binary cache lives under. */
  readonly cacheDir: string
  /** Downloads one URL; injectable so tests need no network. */
  readonly fetch?: AgentFetcher
  /**
   * Reports where the bytes come from, before any network read.
   *
   * A cache hit and a download look identical from the outside and take very
   * different amounts of time, so a caller that shows progress needs to tell
   * them apart.
   */
  readonly onSource?: (source: 'cache' | 'network') => void
}

/**
 * Name the release asset for a machine's reported platform.
 *
 * Matching is case-insensitive because `uname` casing is not portable, and
 * both the GNU and the BSD spelling of each architecture is accepted so the
 * plugin never depends on which userland `uname` came from.
 * @param platform - `uname -s` output, e.g. `Linux`.
 * @param arch - `uname -m` output, e.g. `x86_64`.
 * @returns the release asset name.
 * @throws when the machine reports a platform or architecture with no asset.
 */
export function agentAssetName(platform: string, arch: string): string {
  return binaryAssetName(AGENT_MEMBER, platform, arch)
}

/**
 * Name the release asset carrying the native PTC program host.
 * @param platform - `uname -s` output, e.g. `Linux`.
 * @param arch - `uname -m` output, e.g. `x86_64`.
 * @returns the release asset name.
 * @throws when the machine reports a platform or architecture with no asset.
 */
export function ptcHostAssetName(platform: string, arch: string): string {
  return binaryAssetName(PTC_HOST_MEMBER, platform, arch)
}

/**
 * Name one binary's release asset for a machine's reported platform.
 * @param binary - the release member the archive holds.
 * @param platform - `uname -s` output.
 * @param arch - `uname -m` output.
 * @returns the asset name.
 * @throws when the machine reports a platform or architecture with no asset.
 */
function binaryAssetName(binary: string, platform: string, arch: string): string {
  const os = PLATFORMS[platform.trim().toLowerCase()]
  const cpu = ARCHITECTURES[arch.trim().toLowerCase()]
  if (os === undefined || cpu === undefined) {
    throw new Error(
      `the machine reports platform "${platform.trim()}" and architecture "${arch.trim()}", `
      + `which has no ${binary} release; it ships for Linux and Darwin on x86_64`,
    )
  }
  return `${binary}-${os}-${cpu}`
}

/** The release file one asset is published as. */
function archiveName(assetName: string): string {
  return `${assetName}.tar.gz`
}

/** The direct download address of one platform's archive. */
export function agentArchiveUrl(version: string, assetName: string): string {
  return `${DOWNLOAD_ROOT}/v${version}/${archiveName(assetName)}`
}

/** The direct download address of one version's sums file. */
export function agentSumsUrl(version: string): string {
  return `${DOWNLOAD_ROOT}/v${version}/${SUMS_FILE}`
}

/** Download one URL, or fail with a message that names it. */
async function download(fetcher: AgentFetcher, url: string): Promise<Buffer> {
  try {
    return await fetcher(url)
  } catch (error) {
    throw new Error(
      `downloading ${url} failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

/** The real HTTPS GET, refusing any non-2xx answer. */
async function fetchOverHttps(url: string): Promise<Buffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
  return Buffer.from(await response.arrayBuffer())
}

/** One tar header field, read to its NUL or its field boundary and trimmed. */
function headerText(header: Buffer, start: number, length: number): string {
  const nul = header.indexOf(0, start)
  const end = nul === -1 || nul > start + length ? start + length : nul
  return header.toString('utf8', start, end).trim()
}

/** The octal byte count of one tar header's data. */
function headerSize(header: Buffer): number {
  const text = headerText(header, 124, 12)
  return text === '' ? 0 : Number.parseInt(text, 8)
}

/**
 * The agent binary inside one release archive.
 *
 * Only what this repository's own release job writes needs to be understood:
 * one regular file, named by the caller, packed by `tar -czf`. A tar may
 * write metadata records ahead of it — a PAX header from a newer tar, a long
 * name — so every record is stepped over by its own size until the file is
 * found, rather than assuming it comes first.
 * @param archive - the `.tar.gz` bytes.
 * @param sourceUrl - the URL they came from, for the diagnostic.
 * @returns the member's bytes.
 * @throws when the archive carries no such member or is not a gzipped tar.
 */
function archiveMember(archive: Buffer, sourceUrl: string, member: string): Buffer {
  let tar: Buffer
  try {
    tar = gunzipSync(archive)
  } catch (error) {
    // A proxy or a captive portal can answer a download with a readable page
    // instead of the archive; saying so beats a raw decompressor error.
    throw new Error(`${sourceUrl} is not a gzipped tar archive`, { cause: error })
  }
  for (let offset = 0; offset + TAR_BLOCK <= tar.length;) {
    const header = tar.subarray(offset, offset + TAR_BLOCK)
    // Two zero blocks mark the end of the archive.
    if (header.every(byte => byte === 0)) break
    const size = headerSize(header)
    const start = offset + TAR_BLOCK
    const type = String.fromCharCode(header[156] ?? 0)
    const name = headerText(header, 0, 100)
    // NUL and '0' are the regular-file records; every other type is metadata.
    if ((type === '0' || type === '\0') && name.split('/').pop() === member) {
      return tar.subarray(start, start + size)
    }
    offset = start + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
  }
  throw new Error(`${sourceUrl} carries no "${member}"`)
}

/**
 * Read the expected hash for one release file out of a `SHA256SUMS` body.
 * @param sums - the decoded sums file.
 * @param fileName - the release file to look up.
 * @param sumsUrl - the URL the sums came from, for the diagnostic.
 * @returns the expected lowercase hex digest.
 * @throws when the sums file names no such file.
 */
function expectedChecksum(sums: string, fileName: string, sumsUrl: string): string {
  for (const line of sums.split('\n')) {
    // `<hex>␠␠<name>`, the format this repository's own release job writes.
    const match = /^([0-9a-f]{64})\s+(.+)$/i.exec(line.trim())
    if (match !== null && match[2]?.trim() === fileName) return match[1]!.toLowerCase()
  }
  throw new Error(`${sumsUrl} names no "${fileName}"`)
}

/**
 * Fetch, verify, unpack, and cache one agent binary.
 *
 * A cached file is returned untouched: it was verified when it was written,
 * and re-hashing every connect would spend a slow link's budget on a file the
 * plugin itself produced.
 * @param options - version, asset, cache directory, and an optional fetch.
 * @returns the verified binary bytes.
 * @throws when the archive cannot be read, fails its checksum, carries no
 *   agent, or the cache cannot be written.
 */
export async function resolveAgentBinary(options: AgentBinaryOptions): Promise<Buffer> {
  const fetcher = options.fetch ?? fetchOverHttps
  const cached = join(options.cacheDir, options.version, options.assetName)
  try {
    const bytes = await readFile(cached)
    options.onSource?.('cache')
    return bytes
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  options.onSource?.('network')
  const archiveUrl = agentArchiveUrl(options.version, options.assetName)
  const sumsUrl = agentSumsUrl(options.version)
  const [archive, sums] = await Promise.all([
    download(fetcher, archiveUrl),
    download(fetcher, sumsUrl),
  ])
  const expected = expectedChecksum(sums.toString('utf8'), archiveName(options.assetName), sumsUrl)
  const actual = createHash('sha256').update(archive).digest('hex')
  if (actual !== expected) {
    throw new Error(
      `the download from ${archiveUrl} failed its SHA-256 check: expected ${expected}, got ${actual}`,
    )
  }
  const binary = archiveMember(archive, archiveUrl, options.member ?? AGENT_MEMBER)

  // A reader of the cache must never observe a partial download, so the bytes
  // land on a private temp path and are renamed into place in one step. The
  // executable bit is set here because the file is copied verbatim to the
  // machine without a second local chmod.
  await mkdir(dirname(cached), { recursive: true, mode: 0o700 })
  const temp = `${cached}.${String(process.pid)}.${randomUUID()}`
  try {
    await writeFile(temp, binary, { mode: 0o755 })
    await rename(temp, cached)
  } catch (error) {
    await rm(temp, { force: true })
    throw error
  }
  return binary
}
