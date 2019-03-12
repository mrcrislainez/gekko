const Buzzex = require('buzzex-gekko-npm');
const moment = require('moment');
const _ = require('lodash');
const exchangeUtils = require('../exchangeUtils');
const retry = exchangeUtils.retry;
const scientificToDecimal = exchangeUtils.scientificToDecimal;

const marketData = require('./buzzex-markets.json');

const Trader = function(config) {
  _.bindAll(this);

  if(_.isObject(config)) {
    this.key = config.key;
    this.secret = config.secret;
    this.currency = config.currency.toUpperCase()
    this.asset = config.asset.toUpperCase();
  }

  this.name = 'Buzzex';
  this.since = null;
  
  this.market = _.find(Trader.getCapabilities().markets, (market) => {
    return market.pair[0] === this.currency && market.pair[1] === this.asset
  });
  this.pair = this.market.book;

  this.interval = 3100;

  this.buzzex = new Buzzex(
    this.key,
    this.secret,
    {timeout: +moment.duration(60, 'seconds')}
  );
}

const recoverableErrors = [
  
];

// errors that might mean
// the API call succeeded.
const unknownResultErrors = [
  'Response code 502',
  'Response code 504',
  'Response code 522',
  'Response code 520',
]

const includes = (str, list) => {
  if(!_.isString(str))
    return false;

  return _.some(list, item => str.includes(item));
}

Trader.prototype.handleResponse = function(funcName, callback, nonMutating, payload) {
  return (error, body) => {

    if(!error && !body) {
      error = new Error('Empty response');
    }

    if(error) {
      if(includes(error.message, recoverableErrors)) {
        error.notFatal = true;
      }

      if(includes(error.message, ['Rate limit exceeded'])) {
        error.notFatal = true;
        error.backoffDelay = 2500;
      }

      if(nonMutating && includes(error.message, unknownResultErrors)) {
        // this call only tried to retrieve data, safe to redo
        error.notFatal = true;
      }

      //condition here...

      return callback(error);
    }
    
    return callback(undefined, body);
  }
};

Trader.prototype.getTrades = function(since, callback, descending) {
  const startTs = since ? moment(since).valueOf() : null;

  const handle = (err, trades) => {

    if (err) return callback(err);

    var parsedTrades = [];
    _.each(trades[this.pair], function(trade) {
      // Even when you supply 'since' you can still get more trades than you asked for, it needs to be filtered
      //if (_.isNull(startTs) || startTs < moment.unix(trade[4]).valueOf()) {
        parsedTrades.push({
          tid: trade.tid,
          date: parseInt(Math.round(trade.timestamp), 10),
          price: parseFloat(trade.price),
          amount: parseFloat(trade.amount)
        });
      //}
    }, this);

    if(descending)
      callback(undefined, parsedTrades.reverse());
    else
      callback(undefined, parsedTrades);
  };

  const reqData = {
    param: this.pair
  };

  console.log(since);

  if(since) {
    reqData.param = this.pair + "/" +(since/1000);
  }

  const fetch = cb => this.buzzex.api('trades', reqData, this.handleResponse('getTrades', cb, true));
  
  retry(null, fetch, handle);
};

Trader.prototype.getPortfolio = function(callback) {
  const handle = (err, data) => {
    if(err) return callback(err);


    var portfolio = [];
    _.each(data.funds, function(currency) {
      
      portfolio.push({ name: currency[0], amount: currency[1] });
      
    }, this);

    return callback(undefined, portfolio);
  };

  const fetch = cb => this.buzzex.api('getinfo', {}, this.handleResponse('getPortfolio', cb, true));
  retry(null, fetch, handle);
};

// This assumes that only limit orders are being placed with standard assets pairs
// It does not take into account volume discounts.
// Base maker fee is 0.16%, taker fee is 0.26%.
Trader.prototype.getFee = function(callback) {
  const makerFee = 0.02;
  callback(undefined, makerFee / 100);
};

Trader.prototype.getTicker = function(callback) {
  const handle = (err, data) => {
    if (err) return callback(err);

    const result = data[0];
    
    var pair = this.pair.toLowerCase();
    const ticker = {
      ask: result[pair].lowest_ask,
      bid: result[pair].highest_bid
    };

    console.log(ticker);
    callback(undefined, ticker);
  };

  const reqData = {param: this.pair}
  const fetch = cb => this.buzzex.api('ticker', reqData, this.handleResponse('getTicker', cb, true));
  retry(null, fetch, handle);
};

Trader.prototype.roundAmount = function(amount) {
  return _.floor(amount, this.market.amountPrecision);
};

Trader.prototype.roundPrice = function(amount) {
  return scientificToDecimal(_.round(amount, this.market.pricePrecision));
};

Trader.prototype.trade = function(tradeType, amount, price, callback) {
  price = this.roundPrice(price); // only round price, not amount

  const handle = (err, data) => {
    if(err) {
      return callback(err);
    }

    let txid;

    if(data.catched) {
      // handled timeout, but order was created
      txid = data.id;
    } else if(_.isString(data)) {
      // handled timeout, order was NOT created
      txid = data;
    } else {
      // normal flow
      txid = data.result.txid[0];
    }

    callback(undefined, txid);
  };

  const reqData = {
    pair: this.pair,
    type: tradeType.toLowerCase(),
    rate: price,
    amount: amount
  };

  const fetch = cb => this.buzzex.api('trade', reqData, this.handleResponse('trade', cb, false, { tradeType, amount, price }));
  retry(null, fetch, handle);
};


Trader.prototype.buy = function(amount, price, callback) {
  this.trade('buy', amount, price, callback);
};

Trader.prototype.sell = function(amount, price, callback) {
  this.trade('sell', amount, price, callback);
};


Trader.prototype.getOrder = function(order, callback) {
  const handle = (err, data) => {
    if(err) return callback(err);

    const price = parseFloat( data.orderInfo[ order ].rate );
    const amount = parseFloat( data.orderInfo[ order ].amount );
    const date = moment.unix( data.orderInfo[ order ].timestamp_created );

    callback(undefined, {
      price,
      amount,
      date,
      feePercent: 0.16 // default for now
    });
  };

  const reqData = {param: order};

  const fetch = cb => this.buzzex.api('order-info', reqData, this.handleResponse('getOrder', cb, true));
  retry(null, fetch, handle);
}

Trader.prototype.checkOrder = function(order, callback) {

};

Trader.prototype.cancelOrder = function(order, callback) {
  const handle = (err, data) => {
    if(err) return callback(err);

    const result = data.data;
    
    //TODO: incorrect response

    callback(undefined, {
      executed: result.vol === result.vol_exec,
      open: result.status === 'open',
      filledAmount: +result.vol_exec
    });
  };

  const reqData = {param: order};

  const fetch = cb => this.buzzex.api('cancel-order', reqData, this.handleResponse('checkOrder', cb, true));
  retry(null, fetch, handle);
};


Trader.prototype.getRawOpenOrders = function(callback) {
  
}

Trader.prototype.getOpenOrders = function(callback) {

  
}

Trader.getCapabilities = function () {
  return {
    name: 'Buzzex',
    slug: 'Buzzex',
    currencies: marketData.currencies,
    assets: marketData.assets,
    markets: marketData.markets,
    requires: ['key', 'secret'],
    providesHistory: 'date',
    providesFullHistory: true,
    tid: 'tid',
    tradable: true,
    gekkoBroker: 0.6
  };
}

module.exports = Trader;
