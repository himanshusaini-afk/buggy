/**
 * Proof-Carrying Program Repair and Debugging System
 *
 * Multi-agent system communicating over MCP for autonomous
 * code analysis, bug proving, and repair.
 */

// Core types
export * from './types/index.js';

// Programmatic API
export { ProofDebugger, default } from './api.js';
export type { ProofDebuggerOptions, InvestigateOptions, QueryCalleesResult } from './api.js';

// CLI utilities (for embedding)
export { detectLanguage } from './cli.js';

// Config
export { loadConfig, ConfigError } from './config/config-loader.js';

// Database
export { initializeDatabase } from './database/graph-db.js';
export { GraphQueries } from './database/graph-queries.js';

// Agents
export {
  ParserAgent,
  BugProvingAgent,
  RepairAgent,
  ClassifierAgent,
  SandboxAgent,
} from './agents/index.js';

// Orchestrator
export { AgentOrchestrator, SandboxUnavailableError } from './orchestrator/orchestrator.js';

// Experience memory
export { WatchlistRecorder } from './watchlist/watchlist-recorder.js';
export { WatchlistStore } from './watchlist/watchlist-store.js';
export { Retrospective } from './watchlist/retrospective.js';

// Capability advisor — proposes hooks/steering/skills from defect history
export { CapabilityAdvisor } from './advisor/capability-advisor.js';
export type { CapabilityAdvisorOptions } from './advisor/capability-advisor.js';
