import pino, { LogFn, LogDescriptor } from "pino";
import pretty from "pino-pretty";
import path from "path";
import fs from "fs";

const customLevels: Record<string, number> = {
    fatal: 60,
    error: 50,
    warn: 40,
    info: 30,
    log: 29,
    progress: 28,
    success: 27,
    debug: 20,
    trace: 10,
};

const raw = process?.env?.LOG_JSON_FORMAT || false;

const createStream = () => {
    // Create logs directory if it doesn't exist
    const logsDir = path.join(process.cwd(), 'logs');
    if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir);
    }

    // Create file stream with custom formatting
    const logFile = path.join(logsDir, 'app.log');
    const fileStream = pretty({
        destination: fs.createWriteStream(logFile, { flags: 'a' }),
        colorize: false,
        messageFormat: (log: LogDescriptor, messageKey: string) => {
            const date = new Date().toISOString().replace('T', ' ').slice(0, 19);
            const levelNum = typeof log.level === 'number' ? log.level : 30;
            const level = levelNum >= 50 ? 'ERROR' : 
                         levelNum >= 40 ? 'WARN' : 
                         levelNum >= 30 ? 'INFO' :
                         levelNum >= 28 ? 'PROGRESS' :
                         levelNum >= 27 ? 'SUCCESS' :
                         levelNum >= 20 ? 'DEBUG' : 'TRACE';
            return `[${date}] ${level}: ${log[messageKey]}`;
        },
        ignore: "pid,hostname,level,time",
    });

    // Create pretty console stream with same formatting
    const consoleStream = pretty({
        colorize: true,
        messageFormat: (log: LogDescriptor, messageKey: string) => {
            const date = new Date().toISOString().replace('T', ' ').slice(0, 19);
            const levelNum = typeof log.level === 'number' ? log.level : 30;
            const level = levelNum >= 50 ? 'ERROR' : 
                         levelNum >= 40 ? 'WARN' : 
                         levelNum >= 30 ? 'INFO' :
                         levelNum >= 28 ? 'PROGRESS' :
                         levelNum >= 27 ? 'SUCCESS' :
                         levelNum >= 20 ? 'DEBUG' : 'TRACE';
            return `[${date}] ${level}: ${log[messageKey]}`;
        },
        ignore: "pid,hostname,level,time",
    });

    return pino.multistream([
        { stream: fileStream },
        { stream: consoleStream }
    ]);
};

const defaultLevel = process?.env?.DEFAULT_LOG_LEVEL || "info";

const options = {
    level: defaultLevel,
    customLevels,
    hooks: {
        logMethod(
            inputArgs: [string | Record<string, unknown>, ...unknown[]],
            method: LogFn
        ): void {
            const [arg1, ...rest] = inputArgs;

            if (typeof arg1 === "object") {
                const messageParts = rest.map((arg) =>
                    typeof arg === "string" ? arg : JSON.stringify(arg)
                );
                const message = messageParts.join(" ");
                return method.apply(this, [arg1, message]);
            } else {
                const context = {};
                const messageParts = [arg1, ...rest].map((arg) =>
                    typeof arg === "string" ? arg : arg
                );
                const message = messageParts
                    .filter((part) => typeof part === "string")
                    .join(" ");
                const jsonParts = messageParts.filter(
                    (part) => typeof part === "object"
                );

                Object.assign(context, ...jsonParts);

                return method.apply(this, [context, message]);
            }
        },
    },
};

export const elizaLogger = pino(options, createStream());

export default elizaLogger;
