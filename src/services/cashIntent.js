// The cash-sentence parser moved to src/shared/cashIntent.js so the agent's
// serverless executors can use the same one. This path stays for the screens
// that import it.
export * from '../shared/cashIntent';
export { default } from '../shared/cashIntent';
