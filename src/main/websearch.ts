import * as https from 'https'

/** Web search that needs no API key (DuckDuckGo HTML version), returns the top few titles + snippets */

function fetchHtml(url: string, redirects = 3): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
          'Accept-Language': 'en-US,en;q=0.9'
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
        let size = 0
        res.on('data', c => {
          size += c.length
          if (size > 512 * 1024) {
            // A results page is ~50KB; anything bigger is not what we asked for
            req.destroy()
            resolve(Buffer.concat(chunks).toString('utf8'))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      }
    )
    req.on('error', reject)
    req.setTimeout(8000, () => req.destroy(new Error('search timed out')))
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

/** DDG links point through /l/?uddg=<encoded real url>; unwrap for a traceable source */
function realUrl(href: string): string {
  try {
    const u = new URL(href, 'https://duckduckgo.com')
    const uddg = u.searchParams.get('uddg')
    return uddg ? decodeURIComponent(uddg) : u.toString()
  } catch {
    return ''
  }
}

export async function searchWeb(query: string): Promise<string> {
  try {
    const html = await fetchHtml(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`)
    const results: string[] = []
    const re =
      /class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) && results.length < 5) {
      const title = strip(m[2])
      const snippet = strip(m[3])
      const url = realUrl(m[1])
      if (title) results.push(`${results.length + 1}. ${title} — ${snippet}${url ? ` (${url})` : ''}`)
    }
    return results.length ? results.join('\n') : 'No results found'
  } catch (err) {
    return `Search failed: ${(err as Error).message}`
  }
}
