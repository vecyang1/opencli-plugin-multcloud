import { evaluate, navigateToOrThrow } from './client.js';

/**
 * Fetch MultCloud account info (Traffic, Plan, Status).
 */
export async function getAccountInfo() {
  await navigateToOrThrow('Manage Clouds and Emails', 'https://app.multcloud.com/mc_project/home_page');

  const js = `(() => {
    const bodyText = document.body.innerText;
    
    // Find traffic
    const trafficMatch = bodyText.match(/Traffic:\\s*([0-9.]+\\s*(?:GB|MB|TB|KB))\\s*\\/\\s*(\\S+)/i);
    const planMatch = bodyText.includes('Lifetime Unlimited') ? 'Lifetime Unlimited' : (bodyText.includes('Unlimited') ? 'Unlimited' : 'Standard');
    
    // Find user profile email or avatar
    const userBtn = document.querySelector('.user-info, .user_name, [class*=\"user\"], .header-user');
    const userEmail = userBtn?.innerText?.trim() || 'Logged In User';

    return {
      ok: true,
      plan: planMatch,
      planKnown: bodyText.includes('Unlimited'),
      // null, not a plausible-looking default: an unreadable quota that prints
      // as a number is a number the user will act on.
      trafficUsed: trafficMatch ? trafficMatch[1] : null,
      trafficTotal: trafficMatch ? trafficMatch[2] : null,
      trafficSummary: trafficMatch ? (trafficMatch[1] + ' / ' + trafficMatch[2]) : null,
      trafficKnown: !!trafficMatch,
      user: userEmail,
      url: location.href
    };
  })()`;

  return await evaluate(js);
}
