import { describe, expect, it } from 'vitest';
import { dashboardHtml } from '../src/dashboard';

describe('self-hosted onboarding dashboard', () => {
  it('opens the complete sample workspace without gating navigation on Meta onboarding', () => {
    const html = dashboardHtml();
    expect(html).toContain('Sample workspace');
    expect(html).toContain('Connect WhatsApp');
    expect(html).toContain("'Inbox'");
    expect(html).toContain("'Contacts'");
    expect(html).toContain("'Templates'");
    expect(html).toContain("'/v1/dashboard/demo/simulate'");
    expect(html).toContain("'/v1/dashboard/demo/clear'");
    expect(html).toContain('password_verifier:await derive');
    expect(html).toContain('password_iterations:600000');
    expect(html).toContain('Start with empty workspace');
  });

  it('renders syntactically valid client JavaScript', () => {
    const html = dashboardHtml();
    const script = html.slice(html.indexOf('<script>') + '<script>'.length, html.indexOf('</script>'));
    expect(() => new Function(script)).not.toThrow();
    expect(script).toContain('password_iterations:600000');
  });
});
