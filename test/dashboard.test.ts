import { describe, expect, it } from 'vitest';
import { dashboardHtml } from '../src/dashboard';

describe('self-hosted onboarding dashboard', () => {
  it('guides webhook verification before the automated Meta connection', () => {
    const html = dashboardHtml();
    expect(html.indexOf('Verify the Meta webhook')).toBeLessThan(html.indexOf('Find and connect the number'));
    expect(html).toContain('Find and connect my number');
    expect(html).toContain('if(result.phone_numbers.length===1)');
    expect(html).not.toContain('id="find-numbers"');
    expect(html).not.toContain('id="save-connection"');
    expect(html).toContain('Manage connection');
    expect(html).toContain('password_verifier:verifier');
    expect(html).toContain('const passwordIterations=600000');
    expect(html).not.toContain('Cloudflare Access required');
    const login = html.slice(html.indexOf('<section id="login"'), html.indexOf('<section id="app"'));
    expect(login).not.toContain('name="email"');
  });

  it('renders syntactically valid client JavaScript with numeric ID validation intact', () => {
    const html = dashboardHtml();
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
    expect(script.match(/\\d\{3,30\}/g)).toHaveLength(1);
  });
});
