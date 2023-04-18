import {SendResponseOptions} from "../chatgpt/types.js";
import {PetExpose} from "./types.js";
export class Log {
    private ctx: PetExpose
    constructor(ctx: PetExpose) {
        this.ctx = ctx
    }
    public info(str: string, ...args: any[]) {
        this.ctx.logger.info(`[plugin] [chatgpt] ${str}`, args)
    }
    public error(...args: any[]) {
        this.ctx.logger.error(`[plugin] [chatgpt] ${args}`)
    }

    public warn(...args: any[]) {
        this.ctx.logger.warn(`[plugin] [chatgpt] ${args}`)
    }

    public debug(...args: any[]) {
        this.ctx.logger.debug(`[plugin] [chatgpt] ${args}`)
    }
}
export function isNotEmptyString(value: any): boolean {
    return typeof value === 'string' && value.length > 0
}

export function sendResponse<T>(options: SendResponseOptions<T>) {
    if (options.type === 'Success') {
        return Promise.resolve({
            message: options.message ?? null,
            data: options.data ?? null,
            status: options.type,
        })
    }

    // eslint-disable-next-line prefer-promise-reject-errors
    return Promise.reject({
        message: options.message ?? 'Failed',
        data: options.data ?? null,
        status: options.type,
    })
}
