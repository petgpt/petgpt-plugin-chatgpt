import {PetExpose, IPetPluginInterface, PluginData, SlotMenu} from './lib/types.js'
import {ChatMessage, chatReplyProcess, getMsgStore, initApi, initEnv} from "./chatgpt/index.js";
import {openai} from "./chatgpt/types.js";
import {Log} from "./lib/helper.js";

let log: Log;
let options = {
    parentMessageId: ''
}
let latestParentMessageId = ''
let controller = new AbortController();
let enableChatContext = false;
let systemMessage = `You are ChatGPT, a large language model trained by OpenAI. Answer as concisely as possible.\nKnowledge cutoff: 2021-09-01\n`
const pluginName = 'chatgpt'
let completionParams: Partial<Omit<openai.CreateChatCompletionRequest, 'messages' | 'n' | 'stream'>> = {// 忽略了 message、n、stream 参数
    model: 'gpt-3.5-turbo-0613',
    max_tokens: 100, // 最大2048，gpt3模型中，一次对话最多生成的token数量
    temperature: 1, // [0, 2], 默认1, 更低更精确，更高随机性增加
    // top_p: 1, // 官方建议temperature与top_p不要一起使用
    presence_penalty: 0, // [-2.0, 2.0], 默认0, 数值越大，越鼓励生成input中没有的文本
    frequency_penalty: 0 // [-2.0, 2.0], 默认0, 数值越大，降低生成的文本的重复率，更容易生成新的东西
}

function updateDB(ctx: PetExpose, data: any) {
    // if(data['enableChatContext']) ctx.db.set('enableChatContext', data['enableChatContext'])
    // if(data['systemMessage']) ctx.db.set('systemMessage', data['systemMessage'])
    // if(data['VITE_OPENAI_API_KEY']) ctx.db.set('VITE_OPENAI_API_KEY', data['VITE_OPENAI_API_KEY'])
    log.debug(`data: ${ctx}`, data)
    Object.keys(data).forEach((key) => {
        // if(data[key]) {
            log.debug(`set: key: `, key, ` to value: `, data[key])
            ctx.db.set(key, data[key])
        // }
    })
}

function initChatParam(ctx: PetExpose) {
    controller = new AbortController();
    enableChatContext = ctx.db.get('enableChatContext') === '' ? false : ctx.db.get('enableChatContext')
    systemMessage = ctx.db.get('systemMessage') || systemMessage

    if (enableChatContext) {
        options.parentMessageId = latestParentMessageId || ''
    } else {
        latestParentMessageId = options.parentMessageId
        options.parentMessageId = ''
    }

    completionParams.max_tokens = +ctx.db.get('max_tokens') || completionParams.max_tokens
    completionParams.temperature = +ctx.db.get('temperature') || completionParams.temperature
    completionParams.presence_penalty = +ctx.db.get('presence_penalty') || completionParams.presence_penalty
    completionParams.frequency_penalty = +ctx.db.get('frequency_penalty') || completionParams.frequency_penalty
    initApi(completionParams) // 修改了completionParams，需要重新初始化api
}
function initChatGPT(ctx: PetExpose) {
    initEnv(ctx)
    initChatParam(ctx)
}
function bindEventListener(ctx: PetExpose) {
    // 监听配置是否发生变化，如果有变化，通过赋予的db权限，获取新的值
    if(!ctx.emitter.listenerCount(`plugin.${pluginName}.config.update`)) {
        ctx.emitter.on(`plugin.${pluginName}.config.update`, (data: any) => {
            updateDB(ctx, data)

            // setting里的配置改变，需要重新初始化api
            initChatGPT(ctx)
            // log.debug(`[event] [plugin.${pluginName}.config.update] receive data:`, data)
        })
    }

    if(!ctx.emitter.listenerCount(`plugin.${pluginName}.data`)) {
        // 监听发来的对话信息，调用chatgpt的api，获取回复
        ctx.emitter.on(`plugin.${pluginName}.data`, (data: PluginData, reload: boolean = false) => {
            let msgStore = getMsgStore();
            if (reload) {
                let parentMsg = msgStore.get(options.parentMessageId);
                console.log(`options.parentMessageId ==> message:`, parentMsg)
                if (parentMsg) {
                    if (parentMsg.parentMessageId) {
                        // grandParentMsg其实就是用户之前输入的msg
                        let grandParentMsg = msgStore.get(parentMsg.parentMessageId)!;
                        console.log(`${parentMsg.text}'s(id: ${options.parentMessageId}) parentMsg is:`, grandParentMsg)
                        data.data = grandParentMsg.text

                        // 重置parentMessageId，如果用户输入的为第一条，那么应该为''
                        // 如果用户输入的不为第一条，那么应该为grandParentMsg的parentMessageId
                        options.parentMessageId = grandParentMsg.parentMessageId ? grandParentMsg.parentMessageId : ''
                    }
                }
            }
            chatReplyProcess({
                message: data.data,
                lastContext: options,
                systemMessage: systemMessage,
                abortSignal: controller.signal,
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
                    // log.debug(firstChunk ? resMessage : `\n${resMessage}`)
                }
            });
            log.debug(`[event] [plugin.${pluginName}.data] receive data:`, data)
        })
    }

    if(!ctx.emitter.listenerCount(`plugin.${pluginName}.slot.push`)) {
        // 监听slot里的数据更新事件
        ctx.emitter.on(`plugin.${pluginName}.slot.push`, (newSlotData: any) => {
            let slotDataList:[] = JSON.parse(newSlotData)
            // log.debug(`receive newSlotData(type: ${typeof slotDataList})(len: ${slotDataList.length}):`, slotDataList)
            for (let i = 0; i < slotDataList.length; i++) {
                let slotData: any = slotDataList[i]
                switch (slotData.type) {
                    case 'switch': {
                        // log.debug(`${i}, switch value:`, slotData.value)
                        ctx.db.set('enableChatContext', slotData.value)
                        break;
                    }
                    case 'dialog': {
                        slotData.value.forEach((diaItem: any) => {
                            // log.debug(`${i}, dialog item:`, diaItem)
                            ctx.db.set(diaItem.name, diaItem.value)
                        })
                        break;
                    }
                    case 'select': {
                        log.debug(`${i}, select value:`, slotData.value)
                        ctx.db.set('selectTest', slotData.value)
                        completionParams.model = slotData.value
                        break;
                    }
                    case 'uploda': {break;}
                    default: {break;}
                }

            }

            // slot里的数据更新，不用重新初始化api，只需要更新对话参数
            initChatParam(ctx)
        })
    }


    if(!ctx.emitter.listenerCount(`plugin.${pluginName}.func.clear`)) {
        // 监听clear事件
        ctx.emitter.on(`plugin.${pluginName}.func.clear`, () => {
            options.parentMessageId = '' // 清空parentMessageId，后面发起的请求找不到前面的对话，就是新的
            controller.abort()
            controller = new AbortController();
            log.debug(`clear`)
        })
    }
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
                {name: 'max_tokens', type: 'input', required: false,
                    message: '最大2048，gpt3模型中，一次对话最多生成的token数量', default: ctx.db.get('max_tokens') || 100},
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
        name: '选择模型',
        menu: {
            type: 'select',
            child: [
                {name: 'gpt3.5', value: 'gpt-3.5-turbo-0613', type: 'select', required: false},
                {name: 'gpt3.5-16k', value: 'gpt-3.5-turbo-16k', type: 'select', required: false},
                {name: 'gpt3.5-16k-0613', value: 'gpt-3.5-turbo-16k-0613', type: 'select', required: false},
            ],
            value: ctx.db.get('selectTest') || 'gpt-3.5-turbo-0613' // 如果没有的话，默认选择第一个标签
        },
        description: "选择模型"
    }
]
export default (ctx: PetExpose): IPetPluginInterface => {
    const register = () => {
        log = new Log(ctx)
        bindEventListener(ctx)
        log.debug(`[register]`)
    }

    const init = () => {
        initChatGPT(ctx)
    }

    const unregister = () => {
        ctx.emitter.removeAllListeners(`plugin.${pluginName}.config.update`)
        ctx.emitter.removeAllListeners(`plugin.${pluginName}.data`)
        ctx.emitter.removeAllListeners(`plugin.${pluginName}.slot.push`)
        ctx.emitter.removeAllListeners(`plugin.${pluginName}.func.clear`)
        log.debug(`[unregister]`)
    }

    return {
        register,
        unregister,
        init,
        config,
        slotMenu,
        handle: (data: PluginData, reload?: boolean) => new Promise(() => {
            ctx.emitter.emit(`plugin.${pluginName}.data`, data, reload) // 转发给自己的listener
            log.debug('[handle]')
        }),
        stop: () => new Promise((resolve, _) => {
            log.debug('[stop]')
            controller.abort("stop generate manually")
            resolve()
        }),
    }
}
