import fs from 'node:fs'
import { join, dirname } from 'node:path'

export const DEFAULT_CDP = 'http://127.0.0.1:9222'
export const LEARNABLE = 'dsh'
export const ARCHIVED = 'dsh已学'
export const DEFAULT_LIMIT = 5

const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function connect(cdp = DEFAULT_CDP) {
  const tabs = await (await fetch(cdp + '/json/list')).json()
  let page = tabs.find(t => t.type === 'page' && t.url.indexOf('douyin.com') >= 0)
  if (!page) {
    page = await (await fetch(cdp + '/json/new?' + encodeURIComponent('https://www.douyin.com/user/self?showSubTab=favorite_folder&showTab=favorite_collection'), { method: 'PUT' })).json()
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(page.webSocketDebuggerUrl)
    let seq = 0
    const pending = new Map()
    ws.onopen = () => resolve({
      page,
      send(method, params = {}) {
        const id = ++seq
        return new Promise((res, rej) => {
          pending.set(id, { res, rej })
          ws.send(JSON.stringify({ id, method, params }))
        })
      },
      close() { try { ws.close() } catch {} }
    })
    ws.onmessage = e => {
      const msg = JSON.parse(e.data)
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id)
        pending.delete(msg.id)
        msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result)
      }
    }
    ws.onerror = () => reject(new Error('WebSocket 连接失败，请先用 start-chrome-douyin.ps1 启动独立 Chrome 并登录抖音'))
  })
}

export async function enable(c) {
  await c.send('Page.enable')
  await c.send('Runtime.enable')
}

export async function ev(c, fn, ...args) {
  const expression = '(' + fn.toString() + ')(' + args.map(a => JSON.stringify(a)).join(',') + ')'
  const r = await c.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error('EVAL=' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text))
  return r.result && r.result.value
}

export async function waitFor(c, fn, { timeout = 15000, interval = 400, arg } = {}) {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    const v = await ev(c, fn, arg)
    if (v && (!Array.isArray(v) || v.length > 0)) return v
    await sleep(interval)
  }
  return null
}

export function gateFn() {
  if (location.host !== 'www.douyin.com') return { ok: false, why: 'NOT_DOUYIN', href: location.href }
  const visible = el => {
    const r = el.getBoundingClientRect(), s = getComputedStyle(el)
    return r.width > 40 && r.height > 40 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth && s.display !== 'none' && s.visibility !== 'hidden'
  }
  const blocked = [...document.querySelectorAll('#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"],iframe[src*="verifycenter"]')].some(visible)
  if (blocked) return { ok: false, why: 'VERIFY_VISIBLE', href: location.href }
  const loginText = [...document.querySelectorAll('body *')].some(n => !n.childElementCount && visible(n) && /扫码登录|验证码登录|登录后即可|请完成下方验证|安全验证|拖动滑块/.test(n.textContent || ''))
  if (loginText) return { ok: false, why: 'LOGIN_REQUIRED', href: location.href }
  return { ok: true, why: 'OK', href: location.href }
}

export async function gate(c) {
  const g = await ev(c, gateFn)
  if (!g || !g.ok) throw new Error('PAGE_GATE ' + JSON.stringify(g))
  return g
}

export async function readFolders(c) {
  await c.send('Page.navigate', { url: 'https://www.douyin.com/user/self?showSubTab=favorite_folder&showTab=favorite_collection' })
  await waitFor(c, () => /favorite_folder/.test(location.href), { timeout: 10000 })
  await waitFor(c, () => [...document.querySelectorAll('li')].some(li => /共\s*\d+\s*作品/.test((li.textContent || '').trim())), { timeout: 20000 })
  await gate(c)
  return ev(c, () => [...document.querySelectorAll('li')]
    .filter(li => /共\s*\d+\s*作品/.test((li.textContent || '').trim()) && li.getBoundingClientRect().width > 100)
    .map(li => {
      const t = (li.textContent || '').trim()
      const m = t.match(/共\s*(\d+)\s*作品/)
      return { name: t.replace(/共\s*\d+\s*作品[\s\S]*$/, '').trim(), count: m ? Number(m[1]) : 0 }
    }))
}

// name 是学习目标，archived 是归档目标；两者都由配置传入，不再写死中文“已学”。
export function resolveTarget(folders, name, archived = ARCHIVED) {
  if (!name) return null
  if (name === archived) return folders.find(f => f.name === name) || null
  return folders.find(f => f.name === name && f.name !== archived) || null
}

export function collectFnImpl() {
  const isVideo = a => {
    const h = a.getAttribute('href') || ''
    return /^\/video\/\d+/.test(h) || /^\/note\/\d+/.test(h) || /douyin\.com\/(video|note)\/\d+/.test(h)
  }
  const fromUl = [...document.querySelectorAll('ul')].filter(ul => !(ul.textContent || '').includes('新建收藏夹'))
  let best = null, bestN = 0
  for (const ul of fromUl) {
    const n = [...ul.querySelectorAll('a')].filter(isVideo).length
    if (n > bestN) { best = ul; bestN = n }
  }
  if (!best || bestN < 3) return []
  const seen = new Set(), out = []
  for (const a of best.querySelectorAll('a')) {
    if (!isVideo(a)) continue
    const h = a.getAttribute('href') || ''
    const full = h.startsWith('//') ? 'https:' + h : (h.startsWith('/') ? 'https://www.douyin.com' + h : h)
    const mm = full.match(/douyin\.com\/(video|note)\/(\d+)/)
    const id = mm ? mm[2] : (full.match(/(\d{10,25})/) || [])[1]
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push({ id, kind: full.includes('/note/') ? 'note' : 'video', url: full, title: (a.innerText || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60) })
  }
  return out
}

// 进入目标收藏夹并滚动采集。返回 { items, diag }，diag 记录页面显示数与实采数的差异，
// 这样 23 对 20 之类的差异不再沉默消失，而是有据可查。
export async function enterAndCollect(c, folderName, archived = ARCHIVED, expectedCount = 0) {
  const entered = await ev(c, ({ nm, arch }) => {
    const pure = s => (s || '').replace(/共\s*\d+\s*作品[\s\S]*$/, '').trim()
    const lis = [...document.querySelectorAll('li')].filter(li => /共\s*\d+\s*作品/.test((li.textContent || '').trim()))
    const li = lis.find(x => pure(x.textContent) === nm && pure(x.textContent) !== arch)
    if (!li) return false
    const p = li.querySelector('p.EL2m9FJy') || li.querySelector('div.OUwG8uvr') || li
    p.click()
    return true
  }, { nm: folderName, arch: archived })
  if (!entered) throw new Error('ENTER_FAILED ' + folderName)

  // 抖音收藏夹常在内部容器滚动，只滚 body 会漏载；一次性找出真正的滚动容器供后续复用。
  await ev(c, () => {
    window.__dyScrollers = [...document.querySelectorAll('*')].filter(el => {
      const s = getComputedStyle(el)
      return (s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 100
    })
    return window.__dyScrollers.length
  })

  let videos = await waitFor(c, collectFnImpl, { timeout: 10000 }) || []
  let rounds = 0, stable = 0
  for (let i = 0; i < 30 && stable < 3; i++) {
    await ev(c, () => {
      window.scrollTo(0, document.body.scrollHeight)
      for (const el of (window.__dyScrollers || [])) el.scrollTop = el.scrollHeight
    })
    rounds = i + 1
    await sleep(450)
    const nv = await ev(c, collectFnImpl)
    if (nv.length > videos.length) { videos = nv; stable = 0 }
    else stable++
  }
  const displayed = Number(expectedCount) || 0
  return {
    items: videos,
    diag: {
      folder: folderName,
      displayed,
      collected: videos.length,
      diff: displayed - videos.length,
      scrollRounds: rounds,
      complete: displayed > 0 ? videos.length >= displayed : stable >= 3
    }
  }
}

export function loadLedger(home) {
  try { const j = JSON.parse(fs.readFileSync(join(home, 'ledger.json'), 'utf8')); return j && typeof j === 'object' ? j : {} } catch { return {} }
}
export function saveLedger(home, obj) { atomicWrite(join(home, 'ledger.json'), obj) }
export function atomicWrite(file, obj) {
  fs.mkdirSync(dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2))
  fs.renameSync(tmp, file)
}

// 运行时配置：优先于 patch 里的 config，落在插件自己的 home 目录，不碰 profile 的 patch 文件。
export function loadRuntimeConfig(home) {
  try { const j = JSON.parse(fs.readFileSync(join(home, 'config.json'), 'utf8')); return j && typeof j === 'object' ? j : {} } catch { return {} }
}
export function saveRuntimeConfig(home, cfg) { atomicWrite(join(home, 'config.json'), cfg) }
