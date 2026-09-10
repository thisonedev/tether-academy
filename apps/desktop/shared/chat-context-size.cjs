// Every prompt in chat.cjs is budgeted against this number, and the model
// recommender assesses fit against the same number, so both read it from
// one place instead of agreeing by hand.
'use strict';

const MODEL_CTX_SIZE = 4096;

module.exports = { MODEL_CTX_SIZE };
