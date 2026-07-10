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
      // Skip rules with invalid regex rather than crashing a whole sync run.
      // RuleEditor surfaces the error at save/preview time so the user can fix it.
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, 'i');
      } catch {
        continue;
      }
      if (re.test(description)) {
        return rule.activityType;
      }
    }
  }
  return amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
}
