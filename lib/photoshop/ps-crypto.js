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
    
    var crypto = require("crypto");
    
    // Constants
    // ---------
    
    var SALT = "Adobe Photoshop",
        NUM_ITERATIONS = 1000,
        ALGORITHM = "des-ede3-cbc",
        KEY_LENGTH = 24,
        IV = new Buffer("000000005d260000", "hex"), // 0000 0000 5d26 0000
        BLOCK_SIZE = 8;

    // TODO: This takes about 5ms on a moderate computer, so could make async.
    // But, this isn't crucial. We only do it once at startup.
    function createDerivedKey(password) {
        return crypto.pbkdf2Sync(password, SALT, NUM_ITERATIONS, KEY_LENGTH);
    }

    function createDecipherStream(derivedKey) {
        return crypto.createDecipheriv(ALGORITHM, derivedKey, IV);
    }

    function createCipherStream(derivedKey) {
        return crypto.createCipheriv(ALGORITHM, derivedKey, IV);
    }

    function encryptedLength(length) {
        // Encrypted length is the first multiple of BLOCK_SIZE that is 
        // strictly larger than the unencrypted length.
        return length + (BLOCK_SIZE - (length % BLOCK_SIZE));
    }

    // for troubleshooting only
    function decipher(derivedKey, buf) {
        var d = crypto.createDecipheriv(ALGORITHM, derivedKey, IV);
        return new Buffer(d.update(buf, "binary", "binary") + d.final("binary"), "binary");
    }

    // Public Interface
    // ================
    
    exports.createDerivedKey = createDerivedKey;
    exports.createCipherStream = createCipherStream;
    exports.createDecipherStream = createDecipherStream;
    exports.encryptedLength = encryptedLength;
    exports.BLOCK_SIZE = BLOCK_SIZE;
    exports.decipher = decipher;

}());