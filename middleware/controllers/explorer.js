/*
* Licensed to the Apache Software Foundation (ASF) under one
* or more contributor license agreements.  See the NOTICE file
* distributed with this work for additional information
* regarding copyright ownership.  The ASF licenses this file
* to you under the Apache License, Version 2.0 (the
* "License"); you may not use this file except in compliance
* with the License.  You may obtain a copy of the License at
*
*   http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing,
* software distributed under the License is distributed on an
* "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
* KIND, either express or implied.  See the License for the
* specific language governing permissions and limitations
* under the License.
*
*/

/**
 * @typedef {Object} Transaction
 * @property {string} cmd - The command executed in the transaction (e.g., "SET")
 * @property {string} key - The key being operated on
 * @property {string} value - The value associated with the key
 */

/**
 * @typedef {Object} Block
 * @property {number} id - The unique identifier of the block
 * @property {string} number - The block number as a string
 * @property {Transaction[]} transactions - Array of transactions contained in the block
 * @property {number} size - The size of the block in bytes
 * @property {string} createdAt - The creation timestamp in human-readable format (GMT)
 * @property {number} createdAtEpoch - The creation timestamp as Unix epoch in microseconds
 */

const axios = require('axios');
const { getEnv } = require('../utils/envParser');
const logger = require('../utils/logger');
const  { parseCreateTime, parseTimeToUnixEpoch} = require('../utils/time');
const { applyDeltaEncoding, decodeDeltaEncoding } = require('../utils/encoding');
const sqlite3 = require('sqlite3').verbose();
const path = require("path")

// Initialize SQLite database connection
const dbPath = path.join(__dirname, '../cache/transactions.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        logger.error('Error connecting to SQLite database:', err);
    } else {
        logger.info('Connected to SQLite cache database');
    }
});

/**
 * Fetches explorer data from the EXPLORER_BASE_URL and sends it as a response.
 *
 * @async
 * @function getExplorerData
 * @param {Object} req - The HTTP request object.
 * @param {Object} res - The HTTP response object.
 * @returns {Promise<void>} Sends the fetched data or an error response.
 */
async function getExplorerData(req, res) {
    const baseUrl = `${getEnv("EXPLORER_BASE_URL")}/populatetable`;
    const config = {
        method: 'get',
        maxBodyLength: Infinity,
        url: baseUrl,
    };

    try {
        const response = await axios.request(config);
        return res.send(response.data);
    } catch (error) {
        logger.error('Error fetching explorer data:', error);
        return res.status(500).send({
            error: 'Failed to fetch explorer data',
            details: error.message,
        });
    }
}

/**
 * Fetches block data from the EXPLORER_BASE_URL and sends it as a response.
 *
 * @async
 * @function getBlocks
 * @param {Object} req - The HTTP request object.
 * @param {Object} req.query - The query parameters.
 * @param {number} req.query.start - The starting block number.
 * @param {number} req.query.end - The ending block number.
 * @param {Object} res - The HTTP response object.
 * @returns {Promise<void>} Sends the fetched data or an error response.
 */
async function getBlocks(req, res) {
    const start = parseInt(req.query.start, 10);
    const end = parseInt(req.query.end, 10);

    if (isNaN(start) || isNaN(end)) {
        return res.status(400).send({
            error: 'Pass valid start and end query params as part of the request',
        });
    }
    
    const config = {
        method: 'get',
        maxBodyLength: Infinity,
        url: `${getEnv("EXPLORER_BASE_URL")}/v1/blocks/${start}/${end}`,
    };

    try {
        const response = await axios.request(config);
        /** @type {Array<Block>} */
        const data = response?.data
        return res.send(data);
    } catch (error) {
        logger.error('Error fetching block data:', error);
        return res.status(500).send({
            error: 'Failed to fetch block data',
            details: error.message,
        });
    }
}

/**
 * Fetches block data from the EXPLORER_BASE_URL and sends it as a response.
 *
 * @async
 * @function getBlocks
 * @param {Object} req - The HTTP request object.
 * @param {Object} req.query - The query parameters.
 * @param {number} req.query.start - The starting block number.
 * @param {number} req.query.end - The ending block number.
 * @param {Object} res - The HTTP response object.
 * @returns {Promise<void>} Sends the fetched data or an error response.
 */
async function getEncodedBlocks(req, res) {
    const start = parseInt(req.query.start, 10);
    const end = parseInt(req.query.end, 10);
    
    try {
        logger.info(`Attempting to fetch blocks from cache`);
        const cacheData = await getDataFromCache(start, end);
            
        if (cacheData && cacheData.length > 0) {
            logger.info(`Cache hit for blocks, returned ${cacheData.length} records`);
            let modifiedData = cacheData.map(record => {
                return {
                    epoch: parseTimeToUnixEpoch(record.created_at),
                    volume: record.volume || 0
                };
            });
                
            modifiedData = applyDeltaEncoding(modifiedData);
            return res.send({
                isCached: true,
                ...modifiedData
            });
        }    
        logger.info(`Cache miss for blocks ${start}-${end}, falling back to API`);
        
    } catch (cacheError) {
        logger.error('Error retrieving data from cache. Continue to API fallback', cacheError);
    }
    try {
        const apiData = await getDataFromApi(start, end);
        const modifiedData = applyDeltaEncoding(apiData);
        return res.send(modifiedData);
    } catch (error) {
        logger.error('Error fetching block data from API:', error);
        return res.status(500).send({
            error: 'Failed to fetch block data',
            details: error.message,
        });
    }
}

/**
 * Retrieves data from the SQLite cache
 * 
 * @param {number} start - Start block ID
 * @param {number} end - End block ID
 * @returns {Promise<Array>} - The cached block data
 */
function getDataFromCache(start, end) {
    return new Promise((resolve, reject) => {
        let query;
        let params = [];
        
        // Only add WHERE clause if both start and end are valid numbers
        if (!isNaN(start) && !isNaN(end)) {
            query = `
                SELECT block_id, volume, created_at 
                FROM transactions
                WHERE block_id BETWEEN ? AND ?  
                ORDER BY block_id ASC
            `;
            params = [start, end];
        } else {
            query = `
                SELECT block_id, volume, created_at 
                FROM transactions  
                ORDER BY block_id ASC
                LIMIT 100
            `;
        }
        
        db.all(query, params, (err, rows) => {
            if (err) {
                reject(err);
            } else {
                resolve(rows);
            }
        });
    });
}

/**
 * Retrieves data from the API
 * 
 * @param {number} start - Start block ID
 * @param {number} end - End block ID
 * @returns {Promise<Array>} - The formatted block data
 */
async function getDataFromApi(start, end) {
    let baseUrl = `${getEnv("EXPLORER_BASE_URL")}/v1/blocks/1/100`; //never request the full data

    if (!isNaN(start) && !isNaN(end)) {
        baseUrl = `${getEnv("EXPLORER_BASE_URL")}/v1/blocks/${start}/${end}`;
    }

    const config = {
        method: 'get',
        maxBodyLength: Infinity,
        url: baseUrl,
    };

    const response = await axios.request(config);
    /** @type {Array<Block>} */
    const data = response?.data;
    
    return data.map((record) => {
        return {
            epoch: parseTimeToUnixEpoch(record?.createdAt),
            volume: record?.transactions?.length || 0
        };
    });
}

module.exports = {
    getExplorerData,
    getBlocks,
    getEncodedBlocks
};
