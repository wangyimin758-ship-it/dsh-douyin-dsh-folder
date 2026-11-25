import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_CDP, LEARNABLE, ARCHIVED, DEFAULT_LIMIT,
  connect, enable, gate, readFolders, resolveTarget, enterAndCollect,
  loadLedger, saveLedger, atomicWrite, loadRuntimeConfig, saveRuntimeConfig
} from './lib/core.mjs'

let defineTool = spec => spec
try {
  const mod = await import('@deepseek-ai/dsh-tools')
  if (mod && typeof mod.defineTool === 'function') defineTool = mod.defineTool
} catch {}

export const name = 'douyin-dsh-folder'
export const inject = ['tools', 'systemPrompt']

const SECTION_ORDER = 58
// 公开包不写死任何人的本机路径：未配置或仍是占位符时回退到当前用户 home 下的通用状态目录。
const DEFAULT_HOME = path.join(os.homedir(), '.dsh', 'douyin-dsh-folder-data')
function resolveHome(h) {
  const s = h == null ? '' : String(h).trim()
  return (s && !s.includes('PLACEHOLDER')) ? s : DEFAULT_HOME
}
// 提示词只说流程和边界，不重复工具描述、不写死收藏夹名，省 token 也避免配置改了提示词过期。
const PROMPT = [
  '抖音收藏夹学习：目标收藏夹由插件配置决定（douyin_config 可查可改），只学精确匹配的那一个，其余收藏夹一律不读。',
  '- 流程：douyin_dsh_folders 确认目标存在 → douyin_dsh_pending 取摘要（详情在返回的文件路径）→ 学完 douyin_dsh_mark 记 id。',
  '- 归档只由 douyin_dsh_archive_prepare 出人工步骤，界面勾选未验证，不得宣称已自动移入。',
  '- 页面闸门（登录、验证、非抖音域）由工具自动拦截，不要绕过。'
].join('\n')

function ok(message, data) { return { ok: true, message, data } }
function bad(message, data) { return { ok: false, message, data: data || {} } }
function fail(e) { return bad('TOOL_ERROR: ' + (e && e.message ? e.message : String(e))) }

function ledgerShape(home) {
  const raw = loadLedger(home)
  if (!raw.learned || typeof raw.learned !== 'object') raw.learned = {}
  if (!raw.updatedAt) raw.updatedAt = null
  return raw
}

function makeTools(base) {
  // 每次执行都重新合并运行时配置，改完 douyin_config 立即生效，不用重启插件。
  const cfg = () => {
    const rt = loadRuntimeConfig(base.home)
    return {
      home: base.home,
      cdp: rt.cdp || base.cdp,
      learnable: rt.learnable || base.learnable,
      archived: rt.archived || base.archived,
      defaultLimit: Number(rt.defaultLimit) > 0 ? Math.min(Number(rt.defaultLimit), 50) : base.defaultLimit
    }
  }
  const visible = c => ({ learnable: c.learnable, archived: c.archived, cdp: c.cdp, defaultLimit: c.defaultLimit })

  async function withPage(fn, cdp) {
    const c = await connect(cdp)
    try {
      await enable(c)
      await gate(c)
      return await fn(c)
    } finally {
      try { c.close() } catch {}
    }
  }

  return [
    defineTool({
      name: 'douyin_config',
      description: '查看或修改本插件的收藏夹配置：learnable（学习目标名）、archived（归档目标名）、defaultLimit（默认返回条数）。修改立即生效，不碰 profile 的 patch 文件。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['get', 'set'], description: 'get 查看当前配置；set 修改配置' },
          patch: {
            type: 'object',
            description: 'action=set 时给出要改的字段，未给的保持不变',
            properties: {
              learnable: { type: 'string', description: '要学习的收藏夹精确名称' },
              archived: { type: 'string', description: '归档收藏夹精确名称' },
              defaultLimit: { type: 'integer', description: 'douyin_dsh_pending 默认返回条数，1 到 50' }
            }
          }
        }
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'object' } } } },
      render: (_args, value) => {
        if (!value || !value.ok) return '配置操作失败：' + ((value && value.message) || '未知错误')
        const d = value.data || {}
        return '当前配置：学习=' + d.learnable + '，归档=' + d.archived + '，默认条数=' + d.defaultLimit + '，调试端口=' + d.cdp
      },
      async execute(args = {}) {
        try {
          const cur = cfg() // 已合并基线，校验必须基于完整配置，否则缺字段会漏判同名
          if (args.action !== 'set') return ok('当前生效配置', visible(cur))
          const p = args.patch && typeof args.patch === 'object' ? args.patch : {}
          const candidate = { ...cur }
          for (const k of ['learnable', 'archived']) {
            if (p[k] !== undefined) {
              const v = String(p[k]).trim()
              if (!v) return bad(k + ' 不能为空')
              candidate[k] = v
            }
          }
          if (candidate.learnable === candidate.archived) return bad('学习目标和归档目标不能同名')
          if (p.defaultLimit !== undefined) {
            const n = Number(p.defaultLimit)
            if (!Number.isInteger(n) || n < 1 || n > 50) return bad('defaultLimit 必须是 1 到 50 的整数')
            candidate.defaultLimit = n
          }
          // 校验通过再落盘完整配置，保持运行时文件自洽
          saveRuntimeConfig(base.home, {
            learnable: candidate.learnable,
            archived: candidate.archived,
            defaultLimit: candidate.defaultLimit,
            cdp: candidate.cdp
          })
          return ok('配置已保存，下次工具调用立即生效', visible(cfg()))
        } catch (e) { return fail(e) }
      }
    }),

    defineTool({
      name: 'douyin_dsh_folders',
      description: '只读列出抖音收藏夹数量，并确认配置的“学习收藏夹”是否存在。绝不读视频内容。',
      parameters: { type: 'object', properties: {} },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'object' } } },
        render: (_args, value) => {
          if (!value || !value.ok) return '收藏夹读取失败：' + ((value && value.message) || '未知错误')
          const d = value.data || {}
          const t = d.target ? ('目标「' + d.target.name + '」' + d.target.count + ' 作品') : '目标不存在'
          return t + '；共 ' + d.folderCount + ' 个收藏夹' + (d.target ? '' : '：' + (d.folders || []).map(f => f.name).join('、'))
        }
      },
      async execute() {
        try {
          const c0 = cfg()
          return await withPage(async c => {
            const folders = await readFolders(c)
            const target = resolveTarget(folders, c0.learnable, c0.archived)
            return target
              ? ok('目标收藏夹已确认', { folders, folderCount: folders.length, target })
              : bad('未找到精确匹配的「' + c0.learnable + '」，按约束不读取其它收藏夹', { folders, folderCount: folders.length })
          }, c0.cdp)
        } catch (e) { return fail(e) }
      }
    }),

    defineTool({
      name: 'douyin_dsh_pending',
      description: '只从配置的“学习收藏夹”读取未学视频。返回轻量摘要，完整详情写入本地文件；同时报告页面显示数与实采数的差异。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '本次最多返回条数，默认取配置值，最大 50' }
        }
      },
      output: {
        schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'object' } } },
        render: (_args, value) => {
          if (!value || !value.ok) return '待学读取失败：' + ((value && value.message) || '未知错误')
          const d = value.data || {}
          const lines = (d.items || []).map((v, i) => (i + 1) + '. ' + v.title + ' | ' + v.id)
          const diag = d.diag || {}
          const diff = diag.diff > 0 ? ('，页面显示 ' + diag.displayed + ' 实采 ' + diag.collected + '，差异待查') : ''
          return '待学 ' + d.pending + ' 条，本次 ' + lines.length + ' 条' + diff + '；详情：' + (d.file || '') + '\n' + lines.join('\n')
        }
      },
      async execute(args = {}) {
        try {
          const c0 = cfg()
          const limit = Number(args.limit) > 0 ? Math.min(Number(args.limit), 50) : c0.defaultLimit
          return await withPage(async c => {
            const folders = await readFolders(c)
            const target = resolveTarget(folders, c0.learnable, c0.archived)
            if (!target) return bad('未找到精确匹配的「' + c0.learnable + '」，按约束停止', { folders })
            const result = await enterAndCollect(c, c0.learnable, c0.archived, target.count)
            const all = result.items
            const ledger = ledgerShape(c0.home)
            const pending = all.filter(v => !ledger.learned[v.id])
            // 摘要只给 id 和标题，完整 url 留在详情文件，省对话 token。
            const items = pending.slice(0, limit).map(v => ({ id: v.id, title: v.title, kind: v.kind }))
            const file = c0.home + '/dsh-pending.json'
            atomicWrite(file, { at: new Date().toISOString(), folder: c0.learnable, total: all.length, diag: result.diag, pending })
            return ok('待学列表已生成', { folder: c0.learnable, total: all.length, pending: pending.length, items, diag: result.diag, file })
          }, c0.cdp)
        } catch (e) { return fail(e) }
      }
    }),

    defineTool({
      name: 'douyin_dsh_mark',
      description: '把给定视频 id 记入已学账本，避免重复学习。只影响本地账本，不触碰抖音收藏状态。',
      parameters: {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' }, description: '要标记已学的视频 id 列表' } }
      },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'object' } } } },
      async execute(args = {}) {
        try {
          const ids = Array.isArray(args.ids) ? args.ids.map(String).filter(Boolean) : []
          if (!ids.length) return bad('ids 不能为空')
          const c0 = cfg()
          const ledger = ledgerShape(c0.home)
          const at = new Date().toISOString()
          for (const id of ids) ledger.learned[id] = { at }
          ledger.updatedAt = at
          saveLedger(c0.home, ledger)
          return ok('已记录 ' + ids.length + ' 条已学', { marked: ids.length, total: Object.keys(ledger.learned).length })
        } catch (e) { return fail(e) }
      }
    }),

    defineTool({
      name: 'douyin_dsh_archive_prepare',
      description: '生成把已学视频移入配置的“归档收藏夹”的人工确认步骤。归档勾选流程未验证，本工具不执行移动、不宣称已移入。',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object', properties: { ok: { type: 'boolean' }, message: { type: 'string' }, data: { type: 'object' } } } },
      render: (_args, value) => {
        const steps = (value && value.data && value.data.steps) || []
        return '归档待人工确认：\n' + steps.map((s, i) => (i + 1) + '. ' + s).join('\n')
      },
      async execute() {
        const c0 = cfg()
        const ledger = ledgerShape(c0.home)
        const learned = Object.keys(ledger.learned).length
        const steps = [
          '打开抖音收藏夹页 https://www.douyin.com/user/self?showSubTab=favorite_folder&showTab=favorite_collection',
          '进入精确名为「' + c0.learnable + '」的收藏夹，按已学账本中的 ' + learned + ' 个视频 id 逐一勾选',
          '在“添加视频”弹层中选择目标「' + c0.archived + '」，确认移动',
          '回到文件夹页核对 ' + c0.learnable + ' 数量减少、' + c0.archived + ' 数量增加后再宣称归档完成'
        ]
        return ok('已生成归档人工步骤，未执行移动', { learned, steps, target: c0.archived })
      }
    })
  ]
}

export function apply(ctx, config = {}) {
  const base = {
    home: resolveHome(config.home),
    cdp: config.cdp || DEFAULT_CDP,
    learnable: config.learnable || LEARNABLE,
    archived: config.archived || ARCHIVED,
    defaultLimit: Number(config.defaultLimit) > 0 ? Math.min(Number(config.defaultLimit), 50) : DEFAULT_LIMIT
  }
  const tools = makeTools(base)
  const registered = []
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    for (const t of tools) registered.push(ctx.tools.register(t))
  }
  let section = null
  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    section = ctx.systemPrompt.section({ name: 'plugin:' + name, order: SECTION_ORDER, text: PROMPT })
  }
  const dispose = () => {
    for (const d of registered) { try { if (typeof d === 'function') d() } catch {} }
    if (section) { try { typeof section === 'function' ? section() : (section.dispose && section.dispose()) } catch {} }
  }
  if (ctx.effect && typeof ctx.effect === 'function') ctx.effect(() => dispose)
  return dispose
}
