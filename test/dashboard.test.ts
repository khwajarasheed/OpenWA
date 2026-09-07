import { describe, expect, it } from 'vitest';
import { dashboardHtml } from '../src/dashboard';

describe('developer control plane dashboard', () => {
  it('contains only developer-facing navigation and sandbox guidance', () => {
    const html = dashboardHtml();
    expect(html).toContain('OpenWA Control Plane');
    expect(html).toContain('Access & tokens');
    expect(html).toContain('Webhook inspector');
    expect(html).toContain('MCP server');
    expect(html).toContain('Sandbox mode is active');
    expect(html).not.toContain('Campaigns');
    expect(html).not.toContain('AI Copilot');
    expect(html).not.toContain('Noor Home');
  });

  it('renders syntactically valid client JavaScript', () => {
    const html = dashboardHtml();
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('password_iterations:600000');
  });
});
