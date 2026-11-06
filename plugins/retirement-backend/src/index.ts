/**
 * Retirement demo backend plugin.
 *
 * @packageDocumentation
 */

export { retirementPlugin as default } from './plugin';
export {
  retirementTargetConditions,
  createRetirementTargetConditionalDecision,
  retirementTargetResourceRef,
  retirementTargetRules,
} from './permissions/rules';
export {
  RETIREMENT_DELEGATORS,
  RETIREMENT_INVOKERS,
  canDelegateRetirement,
  canInvokeRetirement,
  evaluateRetirementTarget,
  retirementTargetCriteria,
} from './permissions/evaluator';
