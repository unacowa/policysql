import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const source = path.join(root, 'spec')
const destination = path.join(root, 'website/public/spec')

fs.rmSync(destination, { recursive: true, force: true })
fs.mkdirSync(destination, { recursive: true })
fs.copyFileSync(path.join(source, 'openapi.yaml'), path.join(destination, 'openapi.yaml'))
fs.cpSync(path.join(source, 'schemas'), path.join(destination, 'schemas'), { recursive: true })

console.log('staged OpenAPI and JSON Schemas for static documentation')
