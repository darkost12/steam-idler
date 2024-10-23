/*
 * File: bot.js
 * Project: steam-idler
 * Created Date: 2022-10-17 17:32:28
 * Author: 3urobeat
 *
 * Last Modified: 2024-10-20 18:39:11
 * Modified By: 3urobeat
 *
 * Copyright (c) 2022 - 2024 3urobeat <https://github.com/3urobeat>
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.
 * This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License for more details.
 * You should have received a copy of the GNU General Public License along with this program. If not, see <https://www.gnu.org/licenses/>.
 */


const fs        = require("fs");
const util      = require("util");
const SteamID   = require("steamid");
const SteamTotp = require("steam-totp");
const SteamUser = require("steam-user");
const EResult   = SteamUser.EResult;

const sessionHandler = require("./sessions/sessionHandler.js");
const controller     = require("./controller.js");
const config         = require("../shared/config.json");


/**
 * Constructor Creates a new bot object and logs in the account
 * @param {object} logOnOptions The logOnOptions obj for this account
 * @param {number} loginindex The loginindex for this account
 * @param proxies
 */
const Bot = function(logOnOptions, loginindex, proxies) {

    this.logOnOptions = logOnOptions;
    this.loginindex   = loginindex;
    this.proxy        = proxies[loginindex % proxies.length]; // Spread all accounts equally with a simple modulo calculation

    // Populated by loggedOn event handler, is used by logPlaytime to calculate playtime report for this account
    this.startedPlayingTimestamp = 0;
    this.playedAppIDs = [];

    // Create new steam-user bot object. Disable autoRelogin as we have our own queue system
    this.client = new SteamUser({ autoRelogin: false, renewRefreshTokens: true, httpProxy: this.proxy, protocol: SteamUser.EConnectionProtocol.WebSocket }); // Forcing protocol for now: https://dev.doctormckay.com/topic/4187-disconnect-due-to-encryption-error-causes-relog-to-break-error-already-logged-on/?do=findComment&comment=10917

    this.session;

    // Attach relevant steam-user events
    this.attachEventListeners();

};

module.exports = Bot;


// Handles logging in this account
Bot.prototype.login = async function() {

    /* ------------ Login ------------ */
    if (this.proxy) logger("info", `Logging in ${this.logOnOptions.accountName} in ${config.loginDelay / 1000} seconds with proxy '${this.proxy}'...`, false, true);
        else logger("info", `Logging in ${this.logOnOptions.accountName} in ${config.loginDelay / 1000} seconds...`, false, true);

    // Generate steamGuardCode with shared secret if one was provided
    if (this.logOnOptions.sharedSecret) {
        this.logOnOptions.steamGuardCode = SteamTotp.generateAuthCode(this.logOnOptions.sharedSecret);
    }

    // Get new session for this account and log in
    this.session = new sessionHandler(this.client, this.logOnOptions.accountName, this.loginindex, this.logOnOptions);

    const refreshToken = await this.session.getToken();
    if (!refreshToken) return; // Stop execution if getToken aborted login attempt

    setTimeout(() => this.client.logOn({ "refreshToken": refreshToken }), config.loginDelay); // Log in with logOnOptions

};


// Refresh stats on steamladder
Bot.prototype.refreshStats = async function() {
    if (config.steamladderApiKey) {
        logger("info", `[${this.logOnOptions.accountName}] Refreshing stats`, false, true);

        try {
            const id = this.client.logOnResult.client_supplied_steamid;

            return await fetch(`https://steamladder.com/api/v2/profile/${id}/`, {
                method: "POST",
                headers: { Authorization: "Token " + config.steamladderApiKey },
            });
        } catch (err) {
            logger("warn", `[${this.logOnOptions.accountName}] Failed to refresh stats on steamladder: ${err}`, false, true);

            return;
        }
    }
};


// Attaches Steam event listeners
Bot.prototype.attachEventListeners = function() {

    this.client.on("loggedOn", () => { // This account is now logged on
        controller.nextacc++; // The next account can start

        // If this is a relog then remove this account from the queue and let the next account be able to relog
        if (controller.relogQueue.includes(this.loginindex)) {
            logger("info", `[${this.logOnOptions.accountName}] Relog successful.`);

            controller.relogQueue.splice(controller.relogQueue.indexOf(this.loginindex), 1); // Remove this loginindex from the queue
        }

        // Set online status if enabled (https://github.com/DoctorMcKay/node-steam-user/blob/master/enums/EPersonaState.js)
        if (config.onlinestatus) this.client.setPersona(config.onlinestatus);


        // Check if user provided games specifically for this account
        let configGames = config.playingGames;

        if (typeof configGames[0] == "object") {
            if (Object.keys(configGames[0]).includes(this.logOnOptions.accountName)) configGames = configGames[0][this.logOnOptions.accountName]; // Get the specific settings for this account if included
                else configGames = configGames.slice(1);                                                                                          // ...otherwise remove object containing acc specific settings to use the generic ones
        }


        logger("info", `[${this.logOnOptions.accountName}] Starting to idle ${configGames.length} games...`, false, true);
        this.client.gamesPlayed(configGames);
        this.startedPlayingTimestamp = Date.now();
        this.playedAppIDs = configGames;
        this.refreshStats();
    });


    this.client.chat.on("friendMessage", (msg) => {
        const message = msg.message_no_bbcode;
        const steamID = msg.steamid_friend;
        const steamID64 = new SteamID(String(steamID)).getSteamID64();
        const username  = this.user.users[steamID64] ? this.user.users[steamID64].player_name : ""; // Set username to nothing in case they are not cached yet to avoid errors

        logger("info", `[${this.logOnOptions.accountName}] Friend message from '${username}' (${steamID64}): ${message}`);

        // Respond with afk message if enabled in config
        if (config.afkMessage.length > 0) {
            logger("info", "Responding with: " + config.afkMessage);

            this.client.chat.sendFriendMessage(steamID, config.afkMessage);
        }
    });


    this.client.on("disconnected", (eresult, msg) => { // Handle relogging
        if (controller.relogQueue.includes(this.loginindex)) return; // Don't handle this event if account is already waiting for relog

        logger("info", `[${this.logOnOptions.accountName}] Lost connection to Steam. Message: ${msg}. Trying to relog in ${config.relogDelay / 1000} seconds...`);
        this.handleRelog();
    });


    this.client.on("error", (err) => {
        // Custom behavior for LogonSessionReplaced error
        if (err.eresult == SteamUser.EResult.LogonSessionReplaced) {
            logger("warn", `${logger.colors.fgred}[${this.logOnOptions.accountName}] Lost connection to Steam! Reason: LogonSessionReplaced. I won't try to relog this account because someone else is using it now.`);
            return;
        }

        // Check if this is a login error or a connection loss
        if (controller.nextacc == this.loginindex) { // Login error

            // Invalidate token to get a new session if this error was caused by an invalid refreshToken
            if (err.eresult == EResult.InvalidPassword || err.eresult == EResult.AccessDenied || err == "Error: InvalidSignature") { // These are the most likely enums that will occur when an invalid token was used I guess (Checking via String here as it seems like there are EResults missing)
                logger("debug", "Token login error: Calling SessionHandler's _invalidateTokenInStorage() function to get a new session when retrying this login attempt");

                if (err.eresult == EResult.AccessDenied) logger("warn", `[${this.logOnOptions.accountName}] Detected an AccessDenied login error! This is usually caused by an invalid login token. Deleting login token, please re-submit your Steam Guard code.`);

                this.session.invalidateTokenInStorage();

                setTimeout(() => this.login(), 5000);
                return;
            }

            logger("error", `[${this.logOnOptions.accountName}] Error logging in! ${err}. Continuing with next account...`);
            controller.nextacc++; // The next account can start

        } else { // Connection loss

            // If error occurred during relog (aka logOn gave up because connection is still down), move account to the back of the queue and call handleRelog again
            if (controller.relogQueue.includes(this.loginindex)) {
                logger("warn", `[${this.logOnOptions.accountName}] Failed to relog. Repositioning to the back of the queue and trying again. ${err}`);
                controller.relogQueue.splice(0, 1);
            } else {
                logger("info", `[${this.logOnOptions.accountName}] Lost connection to Steam. ${err}. Trying to relog in ${config.relogDelay / 1000} seconds...`);
            }

            this.handleRelog();
        }
    });


    this.client.on("refreshToken", (newToken) => { // Emitted when refreshToken is auto-renewed by SteamUser
        logger("info", `[${this.logOnOptions.accountName}] SteamUser auto renewed this refresh token, updating database entry...`);

        this.session._saveTokenToStorage(newToken);
    });

};


/**
 * Handles relogging this bot account
 */
Bot.prototype.handleRelog = function() {
    if (controller.relogQueue.includes(this.loginindex)) return; // Don't handle this request if account is already waiting for relog

    // Call logPlaytime to print session results and reset startedPlayingTimestamp
    this.logPlaytimeToFile();

    // Add account to queue
    controller.relogQueue.push(this.loginindex);

    // Check if it's our turn to relog every 1 sec after waiting relogDelay ms
    setTimeout(() => {
        const relogInterval = setInterval(() => {
            if (controller.relogQueue.indexOf(this.loginindex) != 0) return; // Not our turn? stop and retry in the next iteration

            clearInterval(relogInterval); // Prevent any retries
            this.client.logOff();

            logger("info", `[${this.logOnOptions.accountName}] It is now my turn. Relogging in ${config.loginDelay / 1000} seconds...`);

            // Attach relogdelay timeout
            setTimeout(async () => {
                // Generate steamGuardCode with shared secret if one was provided
                if (this.logOnOptions.sharedSecret) {
                    this.logOnOptions.steamGuardCode = SteamTotp.generateAuthCode(this.logOnOptions.sharedSecret);
                }

                const refreshToken = await this.session.getToken();
                if (!refreshToken) return; // Stop execution if getToken aborted login attempt

                logger("info", `[${this.logOnOptions.accountName}] Logging in...`);

                this.client.logOn({ "refreshToken": refreshToken });
                this.refreshStats();
            }, config.loginDelay);
        }, 1000);
    }, config.relogDelay);
};


// Logs playtime to playtime.txt file
Bot.prototype.logPlaytimeToFile = function() {

    if (config.logPlaytimeToFile && this.startedPlayingTimestamp != 0) { // If timestamp is 0 then this was already logged
        logger("debug", `Logging playtime for '${this.logOnOptions.accountName}' to playtime.txt...`);

        // Helper function to convert timestamp into iso date string
        const formatDate = (timestamp) => (new Date(timestamp - (new Date().getTimezoneOffset() * 60000))).toISOString().replace(/T/, " ").replace(/\..+/, "");

        // Append session summary to playtime.txt
        const str = `[${this.logOnOptions.accountName}] Session Summary (${formatDate(this.startedPlayingTimestamp)} - ${formatDate(Date.now())}) ~ Played for ${Math.trunc((Date.now() - this.startedPlayingTimestamp) / 1000)} seconds: ${util.inspect(this.playedAppIDs, false, 2, false)}`; // Inspect() formats array properly

        fs.appendFileSync("./shared/playtime.txt", str + "\n");
    }

    // Reset startedPlayingTimestamp
    this.startedPlayingTimestamp = 0;
    this.playedAppIDs = [];

};
