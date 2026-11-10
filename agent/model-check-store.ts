import { DurableObject } from 'cloudflare:workers'
import { createModelCheckTable, readModelCheck, saveModelCheck } from './model-check'
import type { ModelCheckRun, ModelCheckState } from '../lib/model-check'

/**
 * The daily model check's last result (lib/model-check.ts), in one instance
 * (MODEL_CHECK_INSTANCE). It only stores and reads: the check itself runs in
 * the Worker's scheduled handler, so nothing here can start a model call.
 */
export class ModelCheck extends DurableObject<Cloudflare.Env> {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    createModelCheckTable(ctx.storage.sql)
  }

  save(run: ModelCheckRun): void {
    saveModelCheck(this.ctx.storage.sql, run)
  }

  /** For /api/health. */
  state(): ModelCheckState {
    return readModelCheck(this.ctx.storage.sql, Date.now())
  }
}
