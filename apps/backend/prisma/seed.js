"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * 初始化种子：超管账号 + 2026 规则字典 + 竞赛白名单 + 语言证书白名单 + 演示批次
 * 运行：pnpm db:seed（tsc 编译后执行 prisma/seed.js）
 */
const client_1 = require("@prisma/client");
const argon2 = __importStar(require("argon2"));
const shared_1 = require("@zc/shared");
const rules_2026_1 = require("./rules-2026");
const prisma = new client_1.PrismaClient();
async function main() {
    // 1. 超管
    const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || 'Admin@Zc2026';
    const admin = await prisma.user.upsert({
        where: { username: 'admin' },
        update: {},
        create: {
            username: 'admin',
            passwordHash: await argon2.hash(adminPassword, { type: argon2.argon2id }),
            name: '系统管理员',
            role: shared_1.Role.SUPER_ADMIN,
            mustChangePwd: true,
        },
    });
    console.log(`✔ 超管就绪: admin (id=${admin.id}, 首登须改密)`);
    // 2. 规则字典（按 code upsert，保留已有人工调整的 isActive/version 之外的字段随字典演进）
    for (const r of rules_2026_1.RULES_2026) {
        await prisma.ruleItem.upsert({
            where: { code: r.code },
            update: {
                category: r.category,
                name: r.name,
                description: r.description,
                detailSchema: r.detailSchema,
                defaultScore: r.defaultScore ?? null,
                levelScoreMap: (r.levelScoreMap ?? null),
                caps: (r.caps ?? {}),
                whitelistType: r.whitelistType ?? null,
                evidence: r.evidence,
                exportSlot: r.exportSlot ?? null,
            },
            create: {
                code: r.code,
                category: r.category,
                name: r.name,
                description: r.description,
                detailSchema: r.detailSchema,
                defaultScore: r.defaultScore ?? null,
                levelScoreMap: (r.levelScoreMap ?? null),
                caps: (r.caps ?? {}),
                whitelistType: r.whitelistType ?? null,
                evidence: r.evidence,
                exportSlot: r.exportSlot ?? null,
            },
        });
    }
    console.log(`✔ 规则字典: ${rules_2026_1.RULES_2026.length} 项（品德/学业/文体）`);
    // 3. 白名单：竞赛目录（2026 认定结果）+ 语言证书。同 (type,name,year) 幂等。
    const year = 2026;
    const compEntries = [
        ...rules_2026_1.COMPETITION_A.map((name) => ({ type: 'COMP_A', name, level: 'NATIONAL' })),
        ...rules_2026_1.COMPETITION_B_NATIONAL.map((name) => ({ type: 'COMP_B_NATIONAL', name, level: 'NATIONAL' })),
        ...rules_2026_1.COMPETITION_B_PROVINCIAL.map((name) => ({ type: 'COMP_B_PROVINCIAL', name, level: 'PROVINCIAL' })),
        ...rules_2026_1.COMPETITION_B_MUNICIPAL.map((name) => ({ type: 'COMP_B_MUNICIPAL', name, level: 'MUNICIPAL' })),
    ];
    const existingComp = await prisma.whitelistEntry.findMany({ where: { type: { startsWith: 'COMP_' }, year }, select: { name: true } });
    const seen = new Set(existingComp.map((e) => e.name));
    let compAdded = 0;
    for (const c of compEntries) {
        if (seen.has(c.name))
            continue;
        await prisma.whitelistEntry.create({ data: { type: c.type, name: c.name, year, extra: { level: c.level } } });
        seen.add(c.name);
        compAdded++;
    }
    console.log(`✔ 竞赛白名单: 目录 ${compEntries.length} 项（A类${rules_2026_1.COMPETITION_A.length}/国家级${rules_2026_1.COMPETITION_B_NATIONAL.length}/省级${rules_2026_1.COMPETITION_B_PROVINCIAL.length}/市级${rules_2026_1.COMPETITION_B_MUNICIPAL.length}），新增 ${compAdded}`);
    const existingCert = await prisma.whitelistEntry.findMany({ where: { type: 'CERT_LANG' }, select: { name: true } });
    const certSeen = new Set(existingCert.map((e) => e.name));
    let certAdded = 0;
    for (const c of rules_2026_1.CERT_LANG_ENTRIES) {
        if (certSeen.has(c.name))
            continue;
        await prisma.whitelistEntry.create({ data: { type: 'CERT_LANG', name: c.name, year, extra: c.extra } });
        certSeen.add(c.name);
        certAdded++;
    }
    console.log(`✔ 语言证书白名单: ${rules_2026_1.CERT_LANG_ENTRIES.length} 项，新增 ${certAdded}`);
    // 4. 演示批次（幂等）
    const batch = await prisma.batch.upsert({
        where: { semesterKey: '2025-2026-1' },
        update: {},
        create: {
            semesterKey: '2025-2026-1',
            name: '2025-2026学年第一学期综测',
            status: 'DRAFT',
            phases: [],
        },
    });
    console.log(`✔ 演示批次: ${batch.semesterKey} (id=${batch.id})`);
    console.log('\n全部种子数据就绪。默认超管 admin / 初始密码见 INITIAL_ADMIN_PASSWORD（首登强制改密）。');
}
main()
    .catch((e) => {
    console.error(e);
    process.exitCode = 1;
})
    .finally(() => prisma.$disconnect());
