<?xml version="1.0" encoding="UTF-8"?>
<xsl:stylesheet version="2.0" 
                xmlns:html="http://www.w3.org/1999/xhtml"
                xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9"
                xmlns:image="http://www.google.com/schemas/sitemap-image/1.1"
                xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="html" version="1.0" encoding="UTF-8" indent="yes"/>
  <xsl:template match="/">
    <html xmlns="http://www.w3.org/1999/xhtml">
      <head>
        <title>AniFlix Ultra • Advanced XML Sitemap Index &amp; NxSha Node Matrix</title>
        <style type="text/css">
          :root {
            --bg-base: #040406;
            --bg-surface: #0a0a0f;
            --bg-elevated: #12121a;
            --accent-red: #ff0844;
            --accent-cyan: #00f2fe;
            --accent-emerald: #46d369;
            --text-main: #ffffff;
            --text-secondary: #c4c4d4;
            --text-muted: #7e7e94;
            --glass-bg: rgba(14, 14, 20, 0.92);
            --glass-border: 1px solid rgba(255, 255, 255, 0.12);
            --nxsha-glow: rgba(0, 242, 254, 0.45);
          }

          body {
            font-family: 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: var(--bg-base);
            color: var(--text-main);
            margin: 0;
            padding: 40px 20px;
            background-image: 
              radial-gradient(circle at 10% 0%, rgba(255, 8, 68, 0.08) 0%, transparent 45%),
              radial-gradient(circle at 90% 35%, rgba(0, 242, 254, 0.06) 0%, transparent 45%);
            background-attachment: fixed;
          }

          .container {
            max-width: 1060px;
            margin: 0 auto;
            background: var(--glass-bg);
            border: var(--glass-border);
            border-radius: 24px;
            padding: 35px;
            box-shadow: 0 30px 80px rgba(0, 0, 0, 0.95), 0 0 30px rgba(0, 242, 254, 0.08);
            backdrop-filter: blur(28px);
            -webkit-backdrop-filter: blur(28px);
          }

          .header-flex {
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 16px;
            margin-bottom: 24px;
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            padding-bottom: 20px;
          }

          h1 {
            font-size: clamp(1.4rem, 2.4vw, 1.8rem);
            font-weight: 900;
            color: #fff;
            margin: 0;
            display: flex;
            align-items: center;
            gap: 10px;
            letter-spacing: -0.5px;
          }

          h1 span {
            color: var(--accent-red);
          }

          .nxsha-status-pill {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            background: linear-gradient(135deg, rgba(0, 242, 254, 0.15), rgba(0, 114, 255, 0.15));
            border: 1px solid rgba(0, 242, 254, 0.4);
            color: var(--accent-cyan);
            padding: 6px 14px;
            border-radius: 30px;
            font-size: 11.5px;
            font-weight: 800;
            letter-spacing: 0.5px;
            box-shadow: 0 0 16px var(--nxsha-glow);
          }

          .nxsha-dot {
            width: 7px;
            height: 7px;
            background: var(--accent-emerald);
            border-radius: 50%;
            box-shadow: 0 0 8px var(--accent-emerald);
          }

          p.subtitle {
            color: var(--text-secondary);
            font-size: 14px;
            line-height: 1.6;
            margin: 0 0 28px 0;
          }

          .table-wrapper {
            width: 100%;
            overflow-x: auto;
            border-radius: 14px;
            border: 1px solid rgba(255, 255, 255, 0.07);
          }

          table {
            width: 100%;
            border-collapse: collapse;
            background: rgba(18, 18, 26, 0.6);
          }

          th, td {
            padding: 14px 18px;
            text-align: left;
            border-bottom: 1px solid rgba(255, 255, 255, 0.06);
            font-size: 13.5px;
          }

          th {
            background: rgba(255, 8, 68, 0.12);
            color: var(--accent-red);
            font-weight: 800;
            text-transform: uppercase;
            font-size: 11px;
            letter-spacing: 0.9px;
          }

          tr:last-child td {
            border-bottom: none;
          }

          tr:hover {
            background: rgba(255, 255, 255, 0.035);
          }

          a {
            color: var(--accent-cyan);
            text-decoration: none;
            font-weight: 600;
            word-break: break-all;
            transition: color 0.2s ease;
          }

          a:hover {
            color: var(--accent-red);
            text-decoration: underline;
          }

          .badge {
            background: rgba(70, 211, 105, 0.15);
            color: var(--accent-emerald);
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 11.5px;
            font-weight: 700;
            font-family: ui-monospace, monospace;
          }

          .meta-info {
            margin-top: 24px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 12px;
            color: var(--text-muted);
            border-top: 1px solid rgba(255, 255, 255, 0.06);
            padding-top: 16px;
            flex-wrap: wrap;
            gap: 10px;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header-flex">
            <h1>AniFlix <span>Ultra</span> Sitemap Index</h1>
            <div class="nxsha-status-pill">
              <span class="nxsha-dot"></span>
              <span>NxSha Ultra Engine Active</span>
            </div>
          </div>
          
          <p class="subtitle">
            This human-readable XML sitemap index optimizes crawling efficiency for search engines, indexing core streaming endpoints, deep-linked episode nodes, and high-performance NxSha multi-server routes.
          </p>

          <div class="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Index URL Location</th>
                  <th>Priority Matrix</th>
                  <th>Change Frequency</th>
                  <th>Last Modified</th>
                </tr>
              </thead>
              <tbody>
                <xsl:for-each select="sitemap:urlset/sitemap:url">
                  <tr>
                    <td>
                      <xsl:variable name="itemUrl"><xsl:value-of select="sitemap:loc"/></xsl:variable>
                      <a href="{$itemUrl}"><xsl:value-of select="sitemap:loc"/></a>
                    </td>
                    <td>
                      <span class="badge"><xsl:value-of select="sitemap:priority"/></span>
                    </td>
                    <td><xsl:value-of select="sitemap:changefreq"/></td>
                    <td><xsl:value-of select="sitemap:lastmod"/></td>
                  </tr>
                </xsl:for-each>
              </tbody>
            </table>
          </div>

          <div class="meta-info">
            <span>Powered by AniFlix Ultra Enterprise Architecture</span>
            <span>Zero-Ad DASH/HLS Extractor &amp; Proxy Pipeline</span>
          </div>
        </div>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
