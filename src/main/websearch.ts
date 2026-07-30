import * as https from 'https'

/** 无需 API Key 的网页搜索（DuckDuckGo HTML 版），返回前几条标题+摘要 */

function fetchHtml(url: string, redirects = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6'
        }
      },
      res => {
        const { statusCode, headers } = res
        if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location && redirects > 0) {
          res.resume()
          resolve(fetchHtml(new URL(headers.location, url).toString(), redirects - 1))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      }
    )
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('搜索超时')))
  })
}

function strip(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function searchWeb(query: string): Promise<string> {
  try {
    const html = await fetchHtml(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`)
    const results: string[] = []
    const re =
      /class="result__a"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) && results.length < 5) {
      const title = strip(m[1])
      const snippet = strip(m[2])
      if (title) results.push(`${results.length + 1}. ${title} — ${snippet}`)
    }
    return results.length ? results.join('\n') : '没有找到相关结果'
  } catch (err) {
    return `搜索失败: ${(err as Error).message}`
  }
}
