import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { tagText, searchCorpus } from '../index.js'

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `lc-${tag}-`))
}

function writeCorpus(dir, rows) {
  fs.writeFileSync(
    path.join(dir, 'corpus.jsonl'),
    rows.map((r) => JSON.stringify({ hash: 'h' + Math.random(), at: new Date().toISOString(), tags: [], ...r })).join('\n') + '\n',
    'utf8',
  )
}

test('tagText：能把常见场景分出来', () => {
  assert.ok(tagText('笑死我了这也行').includes('调侃'))
  assert.ok(tagText('太难绷了兄弟').includes('损人'))
  assert.ok(tagText('我太菜了').includes('自嘲'))
  assert.deepEqual(tagText('今天天气还行'), [])
})

test('searchCorpus：标签命中算强匹配', async () => {
  const dir = tmpDir('strong')
  writeCorpus(dir, [
    { text: '笑死我了这也行', tags: ['调侃'] },
    { text: '今天天气不错', tags: [] },
  ])
  const r = await searchCorpus(dir, '想调侃他一下', 3)
  assert.ok(r.examples.length >= 1)
  assert.equal(r.weak, false)
})

test('searchCorpus：只有字面接近时标记 weak', async () => {
  const dir = tmpDir('weak')
  writeCorpus(dir, [{ text: '世界上最想看到那个人的样子', tags: [] }])
  const r = await searchCorpus(dir, '世界上最想看到', 3)
  assert.ok(r.examples.length >= 1)
  assert.equal(r.weak, true, '没有场景命中，只是字面像，必须标 weak')
})

test('searchCorpus：空池不报错', async () => {
  const dir = tmpDir('empty')
  const r = await searchCorpus(dir, '想损他一句', 3)
  assert.deepEqual(r.examples, [])
  assert.equal(r.total, 0)
})
