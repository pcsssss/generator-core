/*
 * Copyright (c) 2013 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */

(function () {
    "use strict";

    // Dependencies
    // ------------
    
    var util = require("util"),
        EventEmitter = require("events").EventEmitter,
        fs = require("fs"),
        net = require("net");

    var OutboundMessage = require("./outbound-message"),
        InboundStreamParser = require("./inbound-stream-parser"),
        psCrypto = require("./ps-crypto");

    
    // Constants
    // ---------
    
    // Protocol constants
    var CONSTANTS = require("./constants").CONSTANTS;
    var corylog = require("./constants").corylog;
    
    var RE_ONLY_DIGITS = /^[0-9]+$/;

    // PhotoshopClient Class
    // =====================
    
    // Constructor
    // -----------
    
    var PhotoshopClient = function (options, connectListener, logger) {
        var self = this;

        function setupStreamHandlers() {
            // This function does NOT set up error handlers, because we want slightly
            // different error handlers depending on whether we have sockets or pipes

            self._inputStreamParser = new InboundStreamParser(self._inputStream, self._derivedKey,
                self._processPayload.bind(self));

            self._inputStream.once("readable", function () {
                corylog("Doing first Read");
                self._inputStreamParser._readInputStream();
            });
                    
            self._pipeQueue = [];
            self._canPipe = true;

            self._outputStream.on("unpipe", function () {
                self._canPipe = true;
                self._pipeWhenFree();
            });
        }
            
        function connectPipes() {
            // If FDs are either numbers or strings that are actually positive integers, then 
            // they're file descriptors. Otherwise, they are named pipes.

            // Parse any FDs that are numbers as strings
            if (typeof options.inputFd === "string" && RE_ONLY_DIGITS.test(options.inputFd)) {
                options.inputFd = parseInt(options.inputFd, 10);
            }
            if (typeof options.outputFd === "string" && RE_ONLY_DIGITS.test(options.outputFd)) {
                options.outputFd = parseInt(options.outputFd, 10);
            }

            // Create read/write streams
            if (typeof options.inputFd === "number") {
                self._inputStream = fs.createReadStream(null, {fd: options.inputFd});
            } else {
                self._inputStream = fs.createReadStream(options.inputFd);
            }
            self._inputStream.on("error", function (err) {
                self.emit("error", "error on input stream: " + err);
            });
                    
            if (typeof options.outputFd === "number") {
                self._outputStream = fs.createWriteStream(null, {fd: options.outputFd});
            } else {
                self._outputStream = fs.createWriteStream(options.outputFd);
            }
            self._outputStream.on("error", function (err) {
                self.emit("error", "error on output stream: " + err);
            });
            
            self._derivedKey = null; // no encryption on pipes

            setupStreamHandlers();

            // Creating pipe connections is synchronous, but sockets are async.
            // We want all code paths to be async.
            process.nextTick(function () { self.emit("connect"); });
        }
        
        function connectSockets() {
            var socket;
    
            function socketConnectErrorHandler(err) {
                self.emit("error", "error connecting socket: " + err);
            }
        
            function socketConnectHandler() {
                socket.removeListener("error", socketConnectErrorHandler);
                socket.on("error", function (err) {
                    self.emit("error", "error on socket: " + err);
                });
        
                self._inputStream = socket;
                self._outputStream = socket;
        
                setupStreamHandlers();
        
                self.emit("connect");
            }

            socket = new net.Socket();
            socket.connect(options.port, options.hostname);
            socket.once("error", socketConnectErrorHandler);
            socket.once("connect", socketConnectHandler);
    
            self._derivedKey = psCrypto.createDerivedKey(options.password);

        }

        if (!(self instanceof PhotoshopClient)) {
            return new PhotoshopClient(options, connectListener, logger);
        } else {
            if (!options) {
                options = {};
            }
        
            self._logger = logger;
            
            if (connectListener) {
                self.once("connect", connectListener);
            }

            if (options.inputFd && options.outputFd) {
                connectPipes();
            } else if (options.hostname && options.port && options.password) {
                setTimeout(connectSockets, 15000);
                //connectSockets();
            } else {
                self.emit("error", "must specify all necessary options for either pipe or socket connection");
            }
        }
    };
    util.inherits(PhotoshopClient, EventEmitter);

    // Member Variables
    // ----------------
        
    PhotoshopClient.prototype._inputStream = null;
    PhotoshopClient.prototype._outputStream = null;
    PhotoshopClient.prototype._derivedKey = null;
    PhotoshopClient.prototype._pipeQueue = null;
    PhotoshopClient.prototype._canPipe = false;
    PhotoshopClient.prototype._commandCount = 0;
    PhotoshopClient.prototype._logger = null;

    // Methods
    // -------

    PhotoshopClient.prototype._pipeWhenFree = function () {
        var self = this;
        
        corylog("_pipeWhenFree? %s, size: %d", self._canPipe, self._pipeQueue.length);
        if (self._canPipe && self._pipeQueue.length > 0) {
            var thePipe = self._pipeQueue.shift();
            thePipe.on("end", function () {
                thePipe.unpipe();
            });
            thePipe.pipe(this._outputStream, {end: false});
        }
        // Continue to try writing as long as there is something left to write
        if (this._pipeQueue.length > 0) {
            process.nextTick(this._doPendingWrites.bind(this));
        }
    };

    PhotoshopClient.prototype.sendCommand = function (javascript) {
        if (this._commandCount >= CONSTANTS.MAX_MESSAGE_ID) {
            this._commandCount = 0;
        }

        corylog("sending javascript %s", javascript.substr(0, 50));

        var id = ++this._commandCount;

        var command = new OutboundMessage(javascript, id, this._derivedKey);
        corylog("Sending command %d - %s", id, javascript.substr(0, 40));
        this._pipeQueue.push(command);
        this._pipeWhenFree();

        return id;
    };

    PhotoshopClient.prototype._processPayload = function (payloadMetadata, payloadStream) {
        var self = this,
            protocolVersion = payloadMetadata.protocolVersion,
            messageType = payloadMetadata.messageType,
            messageID = payloadMetadata.messageID,
            rawMessage = {}; // HACK this isn't really used anymore?

        var concat = require("concat-stream");

        corylog("setting up payload stream handler events %s", JSON.stringify(payloadMetadata));

        function handleMessage(messageBody) {
            corylog("end of _processPayload %s", messageType, messageBody);

            // messageBody = messageBody || "";  // hack for empty payloads
            if (!messageBody || messageBody.length === 0) {
                messageBody = "";
            }

            if (protocolVersion !== CONSTANTS.PROTOCOL_VERSION) {
                self.emit("error", "unknown protocol version", protocolVersion);
            } else if (messageType === CONSTANTS.MESSAGE_TYPE_JAVASCRIPT) {
                var messageBodyString = messageBody.toString("utf8");
                var messageBodyParts = messageBodyString.split("\r");
                var eventName = null;
                var parsedValue = null;

                if (messageBodyParts.length === 2) {
                    eventName = messageBodyParts[0];
                }

                try {
                    parsedValue = JSON.parse(messageBodyParts[messageBodyParts.length - 1]);
                    self._logger.log("got JS message: %j", parsedValue);
                } catch (jsonParseException) {
                    // Many commands pass JSON back. However, some pass strings that result from
                    // toStrings of un-JSON-ifiable data (e.g. "[ActionDescriptor]").
                // TODO: In the future, it might make more sense to have a different slot in
                // the message that gives parsed data (if available) and unparsed string (always)
                    parsedValue = messageBodyParts[messageBodyParts.length - 1];
                }
        
                if (eventName) {
                    self.emit("event", messageID, eventName, parsedValue, rawMessage);
                } else {
                    self.emit("message", messageID, parsedValue, rawMessage);
                }
            } else if (messageType === CONSTANTS.MESSAGE_TYPE_PIXMAP) {
                self.emit("pixmap", messageID, messageBody, rawMessage);
            } else if (messageType === CONSTANTS.MESSAGE_TYPE_ICC_PROFILE) {
                self.emit("iccProfile", messageID, messageBody, rawMessage);
            } else if (messageType === CONSTANTS.MESSAGE_TYPE_ERROR) {
                self.emit("error", { id: messageID, body: messageBody.toString("utf8") });
            } else {
                self.emit("communicationsError", "unknown message type", messageType);
            }
        }

        if (messageType === CONSTANTS.MESSAGE_TYPE_PIXMAP) {
            self.emit("pixmap", messageID, payloadStream, rawMessage);

        } else {
            var concatStream = concat(handleMessage);
            payloadStream.pipe(concatStream);
        }

        //TODO handle stream error here?

    };


        
    // Factory Functions
    // -----------------    
    
    function createClient(options, connectListener, logger) {
        return new PhotoshopClient(options, connectListener, logger);
    }

    // Public Interface
    // =================================

    exports.PhotoshopClient = PhotoshopClient;
    exports.createClient = createClient;
    exports.CONSTANTS = CONSTANTS;
    exports.corylog = corylog;

}());