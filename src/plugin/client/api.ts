/**
 * The one way this plugin's browser half talks to its own management routes.
 *
 * Both client surfaces — the settings section and the terminal chooser — read
 * and write the same host API, so the prefix and the failure path are spelled
 * once here rather than in each of them.
 *
 * @module dsh-remote-workspace/plugin/client/api
 */

/** The host route prefix the management API is registered under. */
export const API = '/dsh-remote-workspace'

/**
 * One JSON request against the management API.
 * @param failure - renders the copy for a status the host did not describe.
 * @param path - the route below the plugin's prefix.
 * @param init - the request to send.
 * @returns the parsed body.
 * @throws when the host answered with a non-2xx status.
 */
export async function request<T>(
  failure: (status: number) => string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    credentials: 'same-origin',
    headers: init?.body === undefined ? {} : { 'content-type': 'application/json' },
    ...init,
  })
  // A failure body is optional: a proxy or an aborted request can answer with
  // something that is not JSON, and the status below is the fact that matters.
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    const message = typeof body === 'object' && body !== null && 'error' in body
      ? String((body as { error: unknown }).error)
      : failure(response.status)
    throw new Error(message)
  }
  return body as T
}
