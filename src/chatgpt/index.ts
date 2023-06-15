import { ChatGPTAPI } from "./chatgpt-api.js";
import {ChatGPTUnofficialProxyAPI} from "./chatgpt-unofficial-proxy-api.js";
// import axios from 'axios'
import { SocksProxyAgent } from 'socks-proxy-agent'
import httpsProxyAgent from 'https-proxy-agent'
import fetch from 'node-fetch'
import {
    ApiModel,
    ChatGPTUnofficialProxyAPIOptions,
    ModelConfig,
    RequestOptions,
    ChatContext,
    BalanceResponse
} from "./types.js";
import {isNotEmptyString, sendResponse} from "../lib/helper.js";
import * as types from "./types.js";
import {ChatGPTAPIOptions, ChatMessage, openai, SendMessageOptions} from "./types.js";
import {PetExpose} from "../lib/types.js";
const { HttpsProxyAgent } = httpsProxyAgent

const ErrorCodeMessage: Record<string, string> = {
    401: '[OpenAI] 提供错误的API密钥 | Incorrect API key provided',
    403: '[OpenAI] 服务器拒绝访问，请稍后再试 | Server refused to access, please try again later',
    502: '[OpenAI] 错误的网关 |  Bad Gateway',
    503: '[OpenAI] 服务器繁忙，请稍后再试 | Server is busy, please try again later',
    504: '[OpenAI] 网关超时 | Gateway Time-out',
    500: '[OpenAI] 服务器繁忙，请稍后再试 | Internal Server Error',
}

let config = {
    VITE_OPENAI_API_KEY: '',
    VITE_OPENAI_ACCESS_TOKEN: '',
    VITE_TIMEOUT_MS: '',
    VITE_OPENAI_API_BASE_URL: '',
    VITE_OPENAI_API_MODEL: '',
    VITE_API_REVERSE_PROXY: '',
    VITE_HTTPS_PROXY: '',
    ALL_PROXY: '',
    VITE_SOCKS_PROXY_HOST: '',
    VITE_SOCKS_PROXY_PORT: '',
};

const timeoutMs: number = !isNaN(+config.VITE_TIMEOUT_MS) ? +config.VITE_TIMEOUT_MS : 30 * 1000
let apiModel: ApiModel
let api: ChatGPTAPI | ChatGPTUnofficialProxyAPI

export function initEnv(ctx: PetExpose) {
    config.VITE_OPENAI_API_KEY = ctx.db.get('VITE_OPENAI_API_KEY') || ''
    config.VITE_OPENAI_ACCESS_TOKEN = ctx.db.get('VITE_OPENAI_ACCESS_TOKEN') || ''
    config.VITE_TIMEOUT_MS = ctx.db.get('VITE_TIMEOUT_MS') || ''
    config.VITE_OPENAI_API_BASE_URL = ctx.db.get('VITE_OPENAI_API_BASE_URL') || ''
    config.VITE_OPENAI_API_MODEL = ctx.db.get('VITE_OPENAI_API_MODEL') || ''
    config.VITE_API_REVERSE_PROXY = ctx.db.get('VITE_API_REVERSE_PROXY') || ''
    config.VITE_HTTPS_PROXY = ctx.db.get('VITE_HTTPS_PROXY') || ''
    config.ALL_PROXY = ctx.db.get('ALL_PROXY') || ''
    config.VITE_SOCKS_PROXY_HOST = ctx.db.get('VITE_SOCKS_PROXY_HOST') || ''
    config.VITE_SOCKS_PROXY_PORT = ctx.db.get('VITE_SOCKS_PROXY_PORT') || ''
}

export async function initApi(completionParams: Partial<Omit<openai.CreateChatCompletionRequest, 'messages' | 'n' | 'stream'>>) {
    if (!isNotEmptyString(config.VITE_OPENAI_API_KEY) && !isNotEmptyString(config.VITE_OPENAI_ACCESS_TOKEN)){
        console.error('缺少VITE_OPENAI_API_KEY或VITE_OPENAI_ACCESS_TOKEN环境变量')
        return
        // throw new Error('Missing VITE_OPENAI_API_KEY or VITE_OPENAI_ACCESS_TOKEN environment variable')
    }

    // More Info: https://github.com/transitive-bullshit/chatgpt-api
    if (isNotEmptyString(config.VITE_OPENAI_API_KEY)) {
        const VITE_OPENAI_API_BASE_URL = config.VITE_OPENAI_API_BASE_URL
        const VITE_OPENAI_API_MODEL = config.VITE_OPENAI_API_MODEL
        // 添加自定义model的支持
        if (!completionParams.model) {
            completionParams.model = isNotEmptyString(VITE_OPENAI_API_MODEL) ? VITE_OPENAI_API_MODEL : 'gpt-3.5-turbo'
        }

        const options: ChatGPTAPIOptions = {
            apiKey: config.VITE_OPENAI_API_KEY,
            completionParams,
            debug: true,
        };

        // increase max token limit if use gpt-4
        if (completionParams.model.toLowerCase().includes('gpt-4')) {
            // if use 32k model
            if (completionParams.model.toLowerCase().includes('32k')) {
                options.maxModelTokens = 32768
                options.maxResponseTokens = 8192
            } else {
                options.maxModelTokens = 8192
                options.maxResponseTokens = 2048
            }
        }

        // 如果使用的16k的模型，修改maxModelTokens和maxResponseTokens
        if (completionParams.model.toLowerCase().includes('16k')) {
            options.maxModelTokens = 16384
            options.maxResponseTokens = 4096
        }

        if (isNotEmptyString(VITE_OPENAI_API_BASE_URL))
            options.apiBaseUrl = `${VITE_OPENAI_API_BASE_URL}/v1`

        setupProxy(options)

        api = new ChatGPTAPI({...options})
        apiModel = 'ChatGPTAPI'
    } else {
        const VITE_OPENAI_API_MODEL = config.VITE_OPENAI_API_MODEL
        const options: ChatGPTUnofficialProxyAPIOptions = {
            accessToken: config.VITE_OPENAI_ACCESS_TOKEN,
            debug: true,
        }
        if (isNotEmptyString(VITE_OPENAI_API_MODEL))
            options.model = VITE_OPENAI_API_MODEL

        if (isNotEmptyString(config.VITE_API_REVERSE_PROXY))
            options.apiReverseProxyUrl = config.VITE_API_REVERSE_PROXY

        setupProxy(options)

        api = new ChatGPTUnofficialProxyAPI({...options})
        apiModel = 'ChatGPTUnofficialProxyAPI'
    }
}


/**
 * 调用chatgpt-api的sendMessage方法，向chatgpt发送消息
 * @param options 包含要发送的消息、上下文、进度回调函数、systemMessage
 */
async function chatReplyProcess(options: RequestOptions) {
    const { message, lastContext, process, systemMessage, abortSignal } = options
    try {
        let options: SendMessageOptions = { timeoutMs, abortSignal }

        if (apiModel === 'ChatGPTAPI') {
            if (isNotEmptyString(systemMessage))
                options.systemMessage = systemMessage
        }

        if (lastContext != null) {
            if (apiModel === 'ChatGPTAPI')
                options.parentMessageId = isNotEmptyString(lastContext.parentMessageId) ? lastContext.parentMessageId : undefined
            else
                options = { ...lastContext }
        }

        let apiOptions: types.SendMessageOptions | types.SendMessageBrowserOptions = {
            ...options,
            onProgress: (partialResponse) => {
                process?.(partialResponse)
            },
        };
        const response = await api.sendMessage(message, apiOptions)

        return sendResponse({ type: 'Success', data: response })
    }
    catch (error: any) {
        const code = error.statusCode
        // TimeoutError: OpenAI timed out waiting for response at pTimeout (chatgpt-api:349)
        // :5173/#/chatgpt:1 Uncaught (in promise) {message: 'OpenAI timed out waiting for response', data: null, status: 'Fail'}
        global.console.log(error)
        if (Reflect.has(ErrorCodeMessage, code))
            return sendResponse({ type: 'Fail', message: ErrorCodeMessage[code] })
        return sendResponse({ type: 'Fail', message: error.message ?? 'Please check the back-end console' })
    }
}

function getMsgStore() {
    if(api instanceof ChatGPTUnofficialProxyAPI) throw new Error('getMsgStore is not supported in ChatGPTUnofficialProxyAPI')
    return api.getMsgStore()
}

/**
 * 查询账号可用余额及有效期等信息
 */
async function fetchBalance(enableProxy: boolean = false) {
    // 计算起始日期和结束日期
    const VITE_OPENAI_API_KEY = config.VITE_OPENAI_API_KEY
    const VITE_OPENAI_API_BASE_URL = config.VITE_OPENAI_API_BASE_URL

    if (!isNotEmptyString(VITE_OPENAI_API_KEY))
        return Promise.resolve('-')

    const API_BASE_URL = isNotEmptyString(VITE_OPENAI_API_BASE_URL)
        ? VITE_OPENAI_API_BASE_URL
        : 'https://api.openai.com'

    const [startDate, endDate] = formatDate()

    // 每月使用量
    const urlUsage = `${API_BASE_URL}/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`
    // const urlUsage = `${API_BASE_URL}/dashboard/billing/credit_grants`

    const headers = {
        'Authorization': `Bearer ${VITE_OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
    }
    let httpsProxy = config.VITE_HTTPS_PROXY || config.ALL_PROXY;
    let agent
    if (httpsProxy) {
        agent = new HttpsProxyAgent(httpsProxy);
    }
    try {
        // 获取已使用量
        console.log(`开始fetch balance`)
        const useResponse = (enableProxy && httpsProxy) ? await fetch(urlUsage, { headers, agent }) : await fetch(urlUsage, { headers })
        console.log(`结束fetch`)
        let useRes = await useResponse.json();
        console.log(`结束useResponse.json(), useRes:`, useRes)
        const usageData = useRes as BalanceResponse
        const usage = Math.round(usageData.total_usage) / 100
        return Promise.resolve(usage || 0 ? `$${usage}` : '-')
    }
    catch(e) {
        console.log(`fetch balance error:`, e)
        return Promise.resolve('-')
    }
}

function formatDate(): string[] {
    const today = new Date()
    const year = today.getFullYear()
    const month = today.getMonth() + 1
    const lastDay = new Date(year, month, 0)
    const formattedFirstDay = `${year}-${month.toString().padStart(2, '0')}-01`
    const formattedLastDay = `${year}-${month.toString().padStart(2, '0')}-${lastDay.getDate().toString().padStart(2, '0')}`
    return [formattedFirstDay, formattedLastDay]
}

/**
 * 获取配置信息对象
 */
async function chatConfig(enableProxy: boolean = false) {
    const balance = await fetchBalance(enableProxy)
    const reverseProxy = config.VITE_API_REVERSE_PROXY ?? '-'
    const httpsProxy = (config.VITE_HTTPS_PROXY || config.ALL_PROXY) ?? '-'
    const socksProxy = (config.VITE_SOCKS_PROXY_HOST && config.VITE_SOCKS_PROXY_PORT)
        ? (`${config.VITE_SOCKS_PROXY_HOST}:${config.VITE_SOCKS_PROXY_PORT}`)
        : '-'
    return sendResponse<ModelConfig>({
        type: 'Success',
        data: { apiModel, reverseProxy, timeoutMs, socksProxy, httpsProxy, balance },
    })
}

/**
 * 根据.env文件中配置的代理信息，设置代理为socks或http
 */
function setupProxy(options: ChatGPTAPIOptions | ChatGPTUnofficialProxyAPIOptions) {
    if (config.VITE_SOCKS_PROXY_HOST && config.VITE_SOCKS_PROXY_PORT) {
        const agent = new SocksProxyAgent({
            hostname: config.VITE_SOCKS_PROXY_HOST,
            port: config.VITE_SOCKS_PROXY_PORT,
        })
        // @ts-ignore
        options.fetch = (url: string, options: any) => {// 这里options的类型是什么？？暂时用的any
            return fetch(url, { agent, ...options })
        }
    }
    else {
        if (config.VITE_HTTPS_PROXY || config.ALL_PROXY) {
            const httpsProxy = config.VITE_HTTPS_PROXY || config.ALL_PROXY
            if (httpsProxy) {
                const agent = new HttpsProxyAgent(httpsProxy)
                // @ts-ignore
                options.fetch = (url: string, options: any) => {// 这里options的类型是什么？？暂时用的any
                    return fetch(url, { agent, ...options })
                }
            }
        }
    }
}

/**
 * 获取当前使用的ApiModel信息
 */
function currentModel(): ApiModel {
    return apiModel
}

// export function getMessageIds() {
//     if (api instanceof ChatGPTAPI) {
//         return api.getIds()
//     }
// }

export type { ChatContext, ChatMessage }

export { chatReplyProcess, chatConfig, currentModel, getMsgStore }
