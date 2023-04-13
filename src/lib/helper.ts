import {SendResponseOptions} from "../chatgpt/types.js";

export function log(str: string, ...args: any[]) {
    console.log(`\t[in plugin!] [chatgpt] ${str}`, args)
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
