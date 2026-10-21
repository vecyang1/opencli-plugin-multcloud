import { evaluate, navigateToOrThrow } from './client.js';

/**
 * List all shared files and shared links from MultCloud.
 */
export async function listShares() {
  await navigateToOrThrow('Shares', 'https://app.multcloud.com/mc_project/shares');

  const js = `(() => {
    const rows = Array.from(document.querySelectorAll('.el-table__row, table tbody tr, .share-item'));
    const items = [];

    rows.forEach(r => {
      const cols = Array.from(r.querySelectorAll('td, .cell')).map(c => c.innerText.trim()).filter(Boolean);
      if (cols.length >= 3) {
        const anchor = r.querySelector('a[href*="http"]');
        const linkText = cols.find(c => /^https?:\\/\\//i.test(c)) || '';
        items.push({
          // name and link are what the CLI renders; they used to be absent
          // entirely, so every share printed undefined (undefined).
          name: cols[0],
          fileName: cols[0],
          link: anchor?.getAttribute('href') || linkText || null,
          type: cols[1] || 'File',
          size: cols[2] || 'N/A',
          sharedOn: cols[3] || 'N/A',
          allowUpload: cols[4] || 'No'
        });
      }
    });

    const bodyText = document.body.innerText;
    const isEmpty = bodyText.includes('haven’t shared any file yet') || items.length === 0;

    return {
      ok: true,
      count: items.length,
      isEmpty,
      shares: items,
      summary: isEmpty ? 'You haven’t shared any file yet.' : \`Found \${items.length} shared files.\`
    };
  })()`;

  return await evaluate(js);
}
