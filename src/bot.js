/*
 * File: this.client.js
 * Project: steam-idler
 * Created Date: 17.10.2022 17:32:28
 * Author: 3urobeat
 *
 * Last Modified: 18.10.2022 12:15:50
 * Modified By: 3urobeat
 *
 * Copyright (c) 2022 3urobeat <https://github.com/HerrEurobeat>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 * You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
 */


const SteamID   = require("steamid");
const SteamTotp = require("steam-totp");
const SteamUser = require("steam-user");

const controller = require("./controller.js");
const config     = require("../config.json");


/**
 * Constructor Creates a new bot object and logs in the account
 * @param {Object} logOnOptions The logOnOptions obj for this account
 * @param {Number} loginindex The loginindex for this account
 * @param {Function} logger The logger function
 */
const bot = function(logOnOptions, loginindex, logger) {

    this.logOnOptions = logOnOptions;
    this.loginindex   = loginindex;
    this.logger       = logger;

    // Create new steam-user bot object
    this.client = new SteamUser({ autoRelogin: false });

    logger("info", `Logging in ${logOnOptions.accountName} in ${config.loginDelay / 1000} seconds...`);
    setTimeout(() => this.client.logOn(logOnOptions), config.loginDelay); // Log in with logOnOptions

    // Attach relevant steam-user events after bot obj is created
    this.client.on("loggedOn", () => { // This account is now logged on
        logger("info", `[${logOnOptions.accountName}] Logged in and idling games.\n`);

        controller.nextacc++; // The next account can start

        // If this is a relog then remove this account from the queue and let the next account be able to relog
        if (controller.relogQueue.includes(loginindex)) {
            logger("info", `[${logOnOptions.accountName}] Relog successful.`);

            controller.relogQueue.splice(controller.relogQueue.indexOf(loginindex), 1); // Remove this loginindex from the queue
        }

        // Set online status if enabled (https://github.com/DoctorMcKay/node-steam-user/blob/master/enums/EPersonaState.js)
        if (config.onlinestatus) this.client.setPersona(config.onlinestatus);
        this.client.gamesPlayed(config.playingGames); // Start playing games
    });


    this.client.on("friendMessage", (steamID, message) => {
        var steamID64 = new SteamID(String(steamID)).getSteamID64();

        logger("info", `[${logOnOptions.accountName}] Friend message from ${steamID64}: ${message}`);

        // Respond with afk message if enabled in config
        if (config.afkMessage.length > 0) {
            logger("info", "Responding with: " + config.afkMessage);

            this.client.chat.sendFriendMessage(steamID, config.afkMessage);
        }
    });


    this.client.on("disconnected", (eresult, msg) => { // Handle relogging
        if (controller.relogQueue.includes(loginindex)) return; // Don't handle this event if account is already waiting for relog

        logger("info", `[${logOnOptions.accountName}] Lost connection to Steam. Message: ${msg}. Trying to relog in ${config.relogDelay / 1000} seconds...`);

        this.handleRelog();
    });

};

module.exports = bot;


// Handles relogging this bot account
bot.prototype.handleRelog = function() {
    if (controller.relogQueue.includes(this.loginindex)) return; // Don't handle this request if account is already waiting for relog

    controller.relogQueue.push(this.loginindex); // Add account to queue

    // Check if it's our turn to relog every 1 sec after waiting relogDelay ms
    setTimeout(() => {
        var relogInterval = setInterval(() => {
            if (controller.relogQueue.indexOf(this.loginindex) != 0) return; // Not our turn? stop and retry in the next iteration

            clearInterval(relogInterval); // Prevent any retries
            this.client.logOff();

            this.logger("info", `[${this.logOnOptions.accountName}] It is now my turn. Relogging in ${config.loginDelay / 1000} seconds...`);

            // Generate steam guard code again if user provided a shared_secret
            if (this.logOnOptions["sharedSecretForRelog"]) {
                this.logOnOptions["twoFactorCode"] = SteamTotp.generateAuthCode(this.logOnOptions["sharedSecretForRelog"]);
            }

            // Attach relogdelay timeout
            setTimeout(() => {
                this.logger("info", `[${this.logOnOptions.accountName}] Logging in...`);

                this.client.logOn(this.logOnOptions);
            }, config.loginDelay);
        }, 1000);
    }, config.relogDelay);
};