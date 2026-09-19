/**
 * A workspace title is read by a person scanning a list, so its contract is
 * that it names the distinguishing facts — the checkout when there is one,
 * then the repository, then the machine — and never an opaque id. These cases
 * pin the fallbacks that keep a title readable when a record is missing or a
 * path has no last segment.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { workspaceLabel } from '../../src/models/worktrees.ts'

test('a title names checkout, repository, and machine in that order', () => {
  assert.equal(
    workspaceLabel({ machine: 'vm149', repoPath: '/workspace/ACM-notes', name: 'web-verify' }),
    'web-verify · ACM-notes · vm149',
  )
})

test('a path with no last segment falls back to the path itself', () => {
  assert.equal(workspaceLabel({ machine: 'box', repoPath: '/', name: 'x' }), 'x · / · box')
  // An empty path is the whole fallback; the builder adds nothing of its own.
  assert.equal(workspaceLabel({ machine: 'box', repoPath: '', name: 'x' }), 'x ·  · box')
})

test('a trailing separator does not produce an empty segment', () => {
  assert.equal(
    workspaceLabel({ machine: 'box', repoPath: '/srv/app/', name: 'x' }),
    'x · app · box',
  )
})

test('a registered repository name wins over the derived one', () => {
  assert.equal(
    workspaceLabel({ machine: 'box', repoPath: '/srv/app', repoName: 'api', name: 'x' }),
    'x · api · box',
  )
})

test('a blank registered name falls back to the path segment', () => {
  assert.equal(
    workspaceLabel({ machine: 'box', repoPath: '/srv/app', repoName: '   ', name: 'x' }),
    'x · app · box',
  )
})

test('a directory opened as itself begins at the repository', () => {
  assert.equal(
    workspaceLabel({ machine: 'vm149', repoPath: '/srv/notes', repoName: 'notes' }),
    'notes · vm149',
  )
})

test('no title part is an id the caller did not ask for', () => {
  const title = workspaceLabel({
    machine: '378d3d80-6fc7-45a7-9893-4174cb582d06',
    repoPath: '/srv/app',
    name: 'x',
  })
  // The machine segment is whatever the caller passed; this pins only that the
  // builder adds nothing of its own.
  assert.equal(title, 'x · app · 378d3d80-6fc7-45a7-9893-4174cb582d06')
})
