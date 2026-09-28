import { renderTemplate } from './sms-templates.service';

describe('renderTemplate', () => {
  it('substitutes every placeholder it has a value for', () => {
    const rendered = renderTemplate(
      'Dear {name}, {plan} for {child} is active until {endDate}. - {businessName}',
      {
        name: 'Shahana Akter',
        plan: '3 Month Membership',
        child: 'Ayaan',
        endDate: '2026-12-20',
        businessName: 'Kid Zone',
      },
    );

    expect(rendered).toBe('Dear Shahana Akter, 3 Month Membership for Ayaan is active until 2026-12-20. - Kid Zone');
  });

  it('renders numbers', () => {
    expect(renderTemplate('Your code is {otp}, valid {minutes} minutes.', { otp: '048213', minutes: 5 })).toBe(
      'Your code is 048213, valid 5 minutes.',
    );
  });

  /**
   * A typo in a template should be visible in the SMS log rather than turning
   * into the word "undefined" in a customer's inbox.
   */
  it('leaves an unknown placeholder untouched', () => {
    expect(renderTemplate('Hello {name}, your {thing} is ready', { name: 'Ayaan' })).toBe(
      'Hello Ayaan, your {thing} is ready',
    );
  });

  it('leaves a placeholder whose value is null or undefined untouched', () => {
    expect(renderTemplate('Ends {endDate}', { endDate: null })).toBe('Ends {endDate}');
    expect(renderTemplate('Ends {endDate}', { endDate: undefined })).toBe('Ends {endDate}');
  });

  it('substitutes a repeated placeholder everywhere', () => {
    expect(renderTemplate('{name}, hi {name}', { name: 'Ria' })).toBe('Ria, hi Ria');
  });

  it('leaves text with no placeholders alone', () => {
    expect(renderTemplate('Thank you for visiting!', {})).toBe('Thank you for visiting!');
  });

  it('ignores braces that are not placeholders', () => {
    expect(renderTemplate('Set { } and {not-a-name}', { name: 'x' })).toBe('Set { } and {not-a-name}');
  });
});
