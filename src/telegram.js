const config = require("../shared/config.json");
const { Telegraf } = require("telegraf");

const passGuardCode = (callback) => {
    const bot = new Telegraf(config.telegramToken);

    bot.on("text", async (ctx) => {
        const code = ctx.update.message.text;

        callback(code);

        await ctx.reply("Sent your message as guard code");
        bot.stop("SIGINT");
    });

    bot.launch();
};

module.exports = { passGuardCode };
