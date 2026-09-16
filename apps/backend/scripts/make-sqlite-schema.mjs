/**
 * 本地开发辅助：把 MySQL 版 schema 转为 SQLite 版（剥离 provider 特有属性）。
 * 生成 prisma/sqlite.schema.prisma，配合 `pnpm db:local` 使用。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', 'prisma', 'schema.prisma');
const dst = join(here, '..', 'prisma', 'sqlite.schema.prisma');

let text = readFileSync(src, 'utf8');
// 1. provider 切换
text = text.replace('provider = "mysql"', 'provider = "sqlite"');
// 2. datasource url（字面量或 env() 形式）改为 SQLITE_URL；未提供时默认 dev.db
const sqliteUrl = process.env.SQLITE_URL ?? 'file:./dev.db';
text = text.replace(/url\s+=\s+(env\("[^"]*"\)|"[^"]*")/, `url = "${sqliteUrl}"`);
// 3. 剥离 @db.* 原生类型注解
text = text.replace(/@db\.[A-Za-z0-9_]+(\([0-9,\s]*\))?/g, '');
// 3.5 SQLite 不支持 Json 默认值的字面量渲染（DEFAULT [] 语法错误）：
//     剥离 Json 字段的 @default("[]")/ @default("{}")，应用层创建时总是显式赋值
text = text.replace(/@default\("\[\]"\)/g, '').replace(/@default\("\{\}"\)/g, '');
// 4. 剥离 fullTextIndex（MySQL 专用）与 @ignore 无关字段安全性无需处理
text = text.replace(/fullTextIndex\s*\n?/g, '');

writeFileSync(dst, text, 'utf8');
console.log('sqlite schema written:', dst);
