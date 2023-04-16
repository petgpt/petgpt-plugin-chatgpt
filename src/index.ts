import {PetExpose, IPetPluginInterface, PluginData, SlotMenu} from './lib/types.js'
import { log } from './lib/helper.js'
import {ChatMessage, chatReplyProcess, initApi, initEnv} from "./chatgpt/index.js";
import {openai} from "./chatgpt/types.js";


let options = {
    parentMessageId: ''
}
let latestParentMessageId = ''
const controller = new AbortController();
const signal = controller.signal;
let enableChatContext = false;
let systemMessage = `You are ChatGPT, a large language model trained by OpenAI. Answer as concisely as possible.\nKnowledge cutoff: 2021-09-01\n`
const pluginName = 'chatgpt'

function updateDB(ctx: PetExpose, data: any) {
    // if(data['enableChatContext']) ctx.db.set('enableChatContext', data['enableChatContext'])
    // if(data['systemMessage']) ctx.db.set('systemMessage', data['systemMessage'])
    // if(data['VITE_OPENAI_API_KEY']) ctx.db.set('VITE_OPENAI_API_KEY', data['VITE_OPENAI_API_KEY'])
    log(`data: ${ctx}`, data)
    Object.keys(data).forEach((key) => {
        // if(data[key]) {
            log(`set: key: `, key, ` to value: `, data[key])
            ctx.db.set(key, data[key])
        // }
    })
}
let completionParams: Partial<Omit<openai.CreateChatCompletionRequest, 'messages' | 'n' | 'stream'>> = {// 忽略了 message、n、stream 参数
    model: 'gpt-3.5-turbo',
    max_tokens: 100, // 最大2048，gpt3模型中，一次对话最多生成的token数量
    temperature: 1, // [0, 2], 默认1, 更低更精确，更高随机性增加
    // top_p: 1, // 官方建议temperature与top_p不要一起使用
    presence_penalty: 0, // [-2.0, 2.0], 默认0, 数值越大，越鼓励生成input中没有的文本
    frequency_penalty: 0 // [-2.0, 2.0], 默认0, 数值越大，降低生成的文本的重复率，更容易生成新的东西
}

function initChatParam(ctx: PetExpose) {
    enableChatContext = ctx.db.get('enableChatContext') || false
    systemMessage = ctx.db.get('systemMessage') || systemMessage

    if (enableChatContext) {
        options.parentMessageId = latestParentMessageId || ''
    } else {
        latestParentMessageId = options.parentMessageId
        options.parentMessageId = ''
    }
}
function initChatGPT(ctx: PetExpose) {
    initEnv(ctx)
    initChatParam(ctx)
    initApi(completionParams)
}
function bindEventListener(ctx: PetExpose) {
    // 监听配置是否发生变化，如果有变化，通过赋予的db权限，获取新的值
    ctx.emitter.on(`plugin.${pluginName}.config.update`, (data: any) => {
        updateDB(ctx, data)

        // setting里的配置改变，需要重新初始化api
        initChatGPT(ctx)
        log(`[event] [plugin.${pluginName}.config.update] receive data:`, data)
    })

    // 监听发来的对话信息，调用chatgpt的api，获取回复
    ctx.emitter.on(`plugin.${pluginName}.data`, (data: PluginData) => {
        chatReplyProcess({
            message: data.data,
            lastContext: options,
            systemMessage: systemMessage,
            abortSignal: signal,
            process: (chat: ChatMessage) => {
                ctx.emitter.emit('upsertLatestText', {
                    id: chat.id,
                    type: 'system',
                    text: chat.text
                })
                latestParentMessageId = chat.id; // 记录下最新的parentMessageId，如果开启了chatContext，就把这个值携带上去
                if (enableChatContext) {
                    options.parentMessageId = chat.id // 如果开启着的，就把最新的parentMessageId携带上去
                }
                // let resMessage = JSON.stringify(chat, null, 2);
                // console.log(firstChunk ? resMessage : `\n${resMessage}`)
            }
        });
        log(`[event] [plugin.${pluginName}.data] receive data:`, data)
    })

    // 监听slot里的数据更新事件
    ctx.emitter.on(`plugin.${pluginName}.slot.push`, (newSlotData: any) => {
        let slotDataList:[] = JSON.parse(newSlotData)
        log(`receive newSlotData(type: ${typeof slotDataList})(len: ${slotDataList.length}):`, slotDataList)
        for (let i = 0; i < slotDataList.length; i++) {
            let slotData: any = slotDataList[i]
            switch (slotData.type) {
                case 'switch': {
                    log(`${i}, switch value:`, slotData.value)
                    ctx.db.set('enableChatContext', slotData.value)
                    break;
                }
                case 'dialog': {
                    slotData.value.forEach((diaItem: any) => {
                        log(`${i}, dialog item:`, diaItem)
                        ctx.db.set(diaItem.name, diaItem.value)
                    })
                    break;
                }
                case 'select': {
                    log(`${i}, select value:`, slotData.value)
                    ctx.db.set('selectTest', slotData.value)
                    break;
                }
                case 'uploda': {break;}
                default: {break;}
            }

        }

        // slot里的数据更新，不用重新初始化api，只需要更新对话参数
        initChatParam(ctx)
    })

    // 监听clear事件
    ctx.emitter.on(`plugin.${pluginName}.func.clear`, () => {
        options.parentMessageId = '' // 清空parentMessageId，后面发起的请求找不到前面的对话，就是新的
        log(`clear`)
    })
}
const config = (ctx: PetExpose) => [
    {
        name: 'VITE_OPENAI_API_KEY',
        type: 'input',
        required: false,
        value: ctx.db.get('VITE_OPENAI_API_KEY') || '',
    },
    {
        name: 'VITE_OPENAI_ACCESS_TOKEN',
        type: 'input',
        required: true,
        value: ctx.db.get('VITE_OPENAI_ACCESS_TOKEN') || '',
    },
    {
        name: 'VITE_TIMEOUT_MS',
        type: 'input',
        required: false,
        value: ctx.db.get('VITE_TIMEOUT_MS') || '',
    },
    {
        name: 'VITE_OPENAI_API_BASE_URL',
        type: 'input',
        required: false,
        value: ctx.db.get('VITE_OPENAI_API_BASE_URL') || '',
    },
    {
        name: 'VITE_OPENAI_API_MODEL',
        type: 'input',
        required: false,
        value: ctx.db.get('VITE_OPENAI_API_MODEL') || '',
    },
    {
        name: 'VITE_API_REVERSE_PROXY',
        type: 'input',
        required: false,
        value: ctx.db.get('VITE_API_REVERSE_PROXY') || '',
    },
    {
        name: 'VITE_HTTPS_PROXY',
        type: 'input',
        required: false,
        value: ctx.db.get('VITE_HTTPS_PROXY') || '',
    },
    {
        name: 'ALL_PROXY',
        type: 'input',
        required: false,
        value: ctx.db.get('ALL_PROXY') || '',
    },
    {
        name: 'VITE_SOCKS_PROXY_HOST',
        type: 'input',
        required: false,
        value: ctx.db.get('VITE_SOCKS_PROXY_HOST') || '',
    },
    {
        name: 'VITE_SOCKS_PROXY_PORT',
        type: 'input',
        required: false,
        value: ctx.db.get('VITE_SOCKS_PROXY_PORT') || '',
    },
]
const slotMenu = (ctx: PetExpose): SlotMenu[] => [
    {
        slot: 1,
        name: "setting",
        menu: {
            type: 'dialog',
            child: [
                {name: 'systemMessage', type: 'input', required: false,
                    message: 'The system message helps set the behavior of the assistant. 例如：You are a helpful assistant.',
                    default: ctx.db.get('systemMessage') || 'You are ChatGPT, a large language model trained by OpenAI. Answer as concisely as possible.\nKnowledge cutoff: 2021-09-01\n'},
                {name: 'temperature', type: 'input', required: false,
                    message: '[0, 2], 默认1, 更低更精确，更高随机性增加.', default: ctx.db.get('temperature') || 1},
                {name: 'presence_penalty', type: 'input', required: false,
                    message: '[-2.0, 2.0], 默认0, 数值越大，越鼓励生成input中没有的文本.', default: ctx.db.get('presence_penalty') || 0},
                {name: 'frequency_penalty', type: 'input', required: false,
                    message: '[-2.0, 2.0], 默认0, 数值越大，降低生成的文本的重复率，更容易生成新的东西', default: ctx.db.get('frequency_penalty') || 0},
            ]
        },
        description: "对话参数设置"
    },
    {
        slot: 2,
        name: 'enableChatContext',
        menu: {
            type: 'switch',
            value: ctx.db.get('enableChatContext') || false
        },
        description: "是否开启上下文"
    },
    {
        slot: 3,
        name: 'selectTest',
        menu: {
            type: 'select',
            child: [
                {name: 'label1', value: 'value1', type: 'select', required: false},
                {name: 'label2', value: 'value2', type: 'select', required: false},
            ],
            value: ctx.db.get('selectTest') || 'value1' // 如果没有的话，默认选择第一个标签
        },
        description: "selectTest"
    }
]
export default (ctx: PetExpose): IPetPluginInterface => {
    const register = () => {
        initChatGPT(ctx)
        bindEventListener(ctx)
        log(`[register]`)
    }

    const unregister = () => {
        ctx.emitter.removeAllListeners(`plugin.${pluginName}.data`)
        ctx.emitter.removeAllListeners(`plugin.${pluginName}.config.update`)
        log(`[unregister]`)
    }

    return {
        name: `petgpt-plugin-${pluginName}`,
        version: '0.0.1',
        description: `${pluginName} plugin for petgpt.`,
        register,
        unregister,
        config,
        slotMenu,
        handle: (data: PluginData) => new Promise((resolve, _) => {
            ctx.emitter.emit(`plugin.${pluginName}.data`, data) // 转发给自己的listener

            // TODO: 这里的返回值再考虑
            resolve({
                id: '',
                success: true,
                body: `receive data: ${data.data}`
            })
            log('[handle]')
        }),
        stop: () => new Promise((resolve, _) => {
            log('[stop]')
            controller.abort("stop generate manually")
            resolve()
        }),
    }
}
