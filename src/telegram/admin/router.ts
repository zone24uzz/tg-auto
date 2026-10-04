import type { Context } from 'grammy';
import { parseCb } from './callback-data.js';
import type { InputPayload } from './state.js';
import type { Toast } from './ui.js';

/** Handles one callback route; returns the toast to answer the callback with. */
export type ActionHandler = (ctx: Context, args: string[]) => Promise<Toast>;

/** Handles the admin's text reply to a pending input. Return 'retry' to keep waiting. */
export type InputHandler = (ctx: Context, text: string, payload: InputPayload) => Promise<'retry' | undefined | void>;

/** Route table for callback buttons and pending text inputs. */
export class AdminRouter {
  private readonly actions = new Map<string, ActionHandler>();
  private readonly inputs = new Map<string, InputHandler>();

  action(route: string, handler: ActionHandler): this {
    if (this.actions.has(route)) throw new Error(`duplicate admin route: ${route}`);
    this.actions.set(route, handler);
    return this;
  }

  input(state: string, handler: InputHandler): this {
    if (this.inputs.has(state)) throw new Error(`duplicate admin input: ${state}`);
    this.inputs.set(state, handler);
    return this;
  }

  hasAction(route: string): boolean {
    return this.actions.has(route);
  }

  findAction(route: string): ActionHandler | undefined {
    return this.actions.get(route);
  }

  findInput(state: string): InputHandler | undefined {
    return this.inputs.get(state);
  }

  routes(): string[] {
    return [...this.actions.keys()];
  }

  /** Runs the handler behind a callback_data string (used to re-render a screen after a change). */
  async go(ctx: Context, data: string): Promise<Toast> {
    const { route, args } = parseCb(data);
    const handler = this.actions.get(route);
    return handler ? handler(ctx, args) : undefined;
  }
}
