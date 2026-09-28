import { Injectable } from '@nestjs/common';
import { SettingsService } from '@modules/settings/settings.service';
import { SettingKey } from '@modules/settings/settings.constants';

export type TemplateValues = Record<string, string | number | null | undefined>;

/**
 * Renders the SMS templates held in Settings.
 *
 * Templates use `{placeholder}` markers so a non-technical admin can reword a
 * message from the settings screen without a deployment. An unknown placeholder
 * is left as-is rather than replaced with "undefined", which makes a typo in a
 * template obvious in the SMS log instead of silently producing a broken
 * message.
 */
@Injectable()
export class SmsTemplatesService {
  constructor(private readonly settings: SettingsService) {}

  /** Renders one of the stored templates, always supplying `{businessName}`. */
  async render(key: SettingKey, values: TemplateValues): Promise<string> {
    const template = (await this.settings.get(key)) as string;
    const businessName = await this.settings.get('businessName');
    return renderTemplate(template, { businessName, ...values });
  }
}

export function renderTemplate(template: string, values: TemplateValues): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = values[name];
    return value === undefined || value === null ? match : String(value);
  });
}
