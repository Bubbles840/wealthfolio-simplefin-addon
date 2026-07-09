import type { ActivityType, MappingRule } from './types';

export function mapTransaction(
  description: string,
  amount: number,
  rules: MappingRule[],
): ActivityType {
  for (const rule of rules) {
    if (rule.matchType === 'contains') {
      if (description.toLowerCase().includes(rule.pattern.toLowerCase())) {
        return rule.activityType;
      }
    } else {
      // Throws on invalid regex — caller's responsibility to validate rules at save time
      const re = new RegExp(rule.pattern, 'i');
      if (re.test(description)) {
        return rule.activityType;
      }
    }
  }
  return amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
}
