import { expect, test } from 'claude-code/testing'

import { suggest } from './editor'

const SCHEMA = {
  db: 'app',
  dbs: ['app', 'billing'],
  tables: { app: ['users', 'user_groups', 'departments'], billing: ['products'] },
  cols: { 'app.users': ['id', 'email', 'department_id'], 'app.departments': ['id', 'name'], 'billing.products': ['id', 'title'] },
}
const at = (text: string) => {
  const lines = text.split('\n')
  return { lines, row: lines.length - 1, col: lines[lines.length - 1]!.length, top: 0, rev: 0 }
}

test('tables after FROM and JOIN', async () => {
  expect(suggest(at('SELECT * FROM us'), SCHEMA)?.items).toEqual(['users', 'user_groups'])
  expect(suggest(at('SELECT * FROM users u JOIN dep'), SCHEMA)?.items).toEqual(['departments'])
})

test('db. lists that database\'s tables, alias. lists its columns', async () => {
  expect(suggest(at('SELECT * FROM billing.'), SCHEMA)?.items).toEqual(['products'])
  expect(suggest(at('SELECT u. FROM users u'.slice(0, 9)), SCHEMA)).toBeUndefined()
  const s = { ...at('SELECT u.em FROM users u'), col: 'SELECT u.em'.length }
  expect(suggest(s, SCHEMA)?.items).toEqual(['email'])
})

test('columns of the statement\'s tables in SELECT and WHERE', async () => {
  const s = { ...at('SELECT dep FROM users'), col: 'SELECT dep'.length }
  expect(suggest(s, SCHEMA)?.items[0]).toBe('department_id')
  expect(suggest(at('SELECT * FROM users WHERE em'), SCHEMA)?.items).toEqual(['email'])
})

test('keywords elsewhere, in the case typed; nothing inside strings', async () => {
  expect(suggest(at('sel'), SCHEMA)?.items).toEqual(['select'])
  expect(suggest(at("SELECT * FROM users WHERE email = 'us"), SCHEMA)).toBeUndefined()
})
