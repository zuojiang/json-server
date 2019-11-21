"use strict";

function ownKeys(object, enumerableOnly) { var keys = Object.keys(object); if (Object.getOwnPropertySymbols) { var symbols = Object.getOwnPropertySymbols(object); if (enumerableOnly) symbols = symbols.filter(function (sym) { return Object.getOwnPropertyDescriptor(object, sym).enumerable; }); keys.push.apply(keys, symbols); } return keys; }

function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; if (i % 2) { ownKeys(source, true).forEach(function (key) { _defineProperty(target, key, source[key]); }); } else if (Object.getOwnPropertyDescriptors) { Object.defineProperties(target, Object.getOwnPropertyDescriptors(source)); } else { ownKeys(source).forEach(function (key) { Object.defineProperty(target, key, Object.getOwnPropertyDescriptor(source, key)); }); } } return target; }

function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

const express = require('express');

const _ = require('lodash');

const pluralize = require('pluralize');

const write = require('./write');

const getFullURL = require('./get-full-url');

const utils = require('../utils');

const delay = require('./delay');

module.exports = (db, name, opts) => {
  // Create router
  const router = express.Router();
  router.use(delay); // Get real resource name

  const resourceAlias = typeof opts.resourceAlias === 'string' && require(opts.resourceAlias) || opts.resourceAlias || {};

  function getRealResource(resourceName) {
    return resourceAlias[resourceName] || resourceName;
  } // Embed function used in GET /name and GET /name/id


  function embed(resource, e) {
    e && [].concat(e).forEach(externalResource => {
      const realResource = getRealResource(externalResource);

      if (db.get(realResource).value) {
        const query = {};
        const singularResource = pluralize.singular(name);
        query[`${singularResource}${opts.foreignKeySuffix}`] = resource.id;
        resource[externalResource] = db.get(realResource).filter(query).value();
      }
    });
  } // Expand function used in GET /name and GET /name/id


  function expand(resource, e) {
    e && [].concat(e).forEach(innerResource => {
      const plural = pluralize(getRealResource(innerResource));

      if (db.get(plural).value()) {
        const prop = `${innerResource}${opts.foreignKeySuffix}`;
        resource[innerResource] = db.get(plural).getById(resource[prop]).value();
      }
    });
  } // POST /name?_split=


  function split(body, e) {
    const keys = [].concat(e);
    const mainBody = {};
    const relativeBodies = {};
    Object.keys(body).forEach(key => {
      if (keys.indexOf(key) === -1) {
        mainBody[key] = body[key];
      } else {
        relativeBodies[key] = body[key];
      }
    });
    return {
      mainBody,
      relativeBodies
    };
  } // GET /name
  // GET /name?q=
  // GET /name?attr=&attr=
  // GET /name?_end=&
  // GET /name?_start=&_end=&
  // GET /name?_embed=&_expand=


  function list(req, res, next) {
    // Resource chain
    let chain = db.get(name); // Remove q, _start, _end, ... from req.query to avoid filtering using those
    // parameters

    let q = req.query.q;
    let _start = req.query._start;
    let _end = req.query._end;
    let _page = req.query._page;
    const _sort = req.query._sort;
    const _order = req.query._order;
    let _limit = req.query._limit;
    const _embed = req.query._embed;
    const _expand = req.query._expand;
    delete req.query.q;
    delete req.query._start;
    delete req.query._end;
    delete req.query._sort;
    delete req.query._order;
    delete req.query._limit;
    delete req.query._embed;
    delete req.query._expand; // Automatically delete query parameters that can't be found
    // in the database

    Object.keys(req.query).forEach(query => {
      const arr = db.get(name).value();

      for (const i in arr) {
        if (_.has(arr[i], query) || query === 'callback' || query === '_' || /_lte$/.test(query) || /_gte$/.test(query) || /_ne$/.test(query) || /_like$/.test(query)) return;
      }

      delete req.query[query];
    });

    if (q) {
      // Full-text search
      if (Array.isArray(q)) {
        q = q[0];
      }

      q = q.toLowerCase();
      chain = chain.filter(obj => {
        for (const key in obj) {
          const value = obj[key];

          if (db._.deepQuery(value, q)) {
            return true;
          }
        }
      });
    }

    Object.keys(req.query).forEach(key => {
      // Don't take into account JSONP query parameters
      // jQuery adds a '_' query parameter too
      if (key !== 'callback' && key !== '_') {
        // Always use an array, in case req.query is an array
        const arr = [].concat(req.query[key]);
        const isDifferent = /_ne$/.test(key);
        const isRange = /_lte$/.test(key) || /_gte$/.test(key);
        const isLike = /_like$/.test(key);
        const path = key.replace(/(_lte|_gte|_ne|_like)$/, '');
        chain = chain.filter(element => {
          return arr.map(function (value) {
            // get item value based on path
            // i.e post.title -> 'foo'
            const elementValue = _.get(element, path); // Prevent toString() failing on undefined or null values


            if (elementValue === undefined || elementValue === null) {
              return;
            }

            if (isRange) {
              const isLowerThan = /_gte$/.test(key);
              return isLowerThan ? value <= elementValue : value >= elementValue;
            } else if (isDifferent) {
              return value !== elementValue.toString();
            } else if (isLike) {
              return new RegExp(value, 'i').test(elementValue.toString());
            } else {
              return value === elementValue.toString();
            }
          }).reduce((a, b) => isDifferent ? a && b : a || b);
        });
      }
    }); // Sort

    if (_sort) {
      const _sortSet = _sort.split(',');

      const _orderSet = (_order || '').split(',').map(s => s.toLowerCase());

      chain = chain.orderBy(_sortSet, _orderSet);
    } // Slice result


    if (_end || _limit || _page) {
      res.setHeader('X-Total-Count', chain.size());
      res.setHeader('Access-Control-Expose-Headers', `X-Total-Count${_page ? ', Link' : ''}`);
    }

    if (_page) {
      _page = parseInt(_page, 10);
      _page = _page >= 1 ? _page : 1;
      _limit = parseInt(_limit, 10) || 10;
      const page = utils.getPage(chain.value(), _page, _limit);
      const links = {};
      const fullURL = getFullURL(req);

      if (page.first) {
        links.first = fullURL.replace(`page=${page.current}`, `page=${page.first}`);
      }

      if (page.prev) {
        links.prev = fullURL.replace(`page=${page.current}`, `page=${page.prev}`);
      }

      if (page.next) {
        links.next = fullURL.replace(`page=${page.current}`, `page=${page.next}`);
      }

      if (page.last) {
        links.last = fullURL.replace(`page=${page.current}`, `page=${page.last}`);
      }

      res.links(links);
      chain = _.chain(page.items);
    } else if (_end) {
      _start = parseInt(_start, 10) || 0;
      _end = parseInt(_end, 10);
      chain = chain.slice(_start, _end);
    } else if (_limit) {
      _start = parseInt(_start, 10) || 0;
      _limit = parseInt(_limit, 10);
      chain = chain.slice(_start, _start + _limit);
    } // embed and expand


    chain = chain.cloneDeep().forEach(function (element) {
      embed(element, _embed);
      expand(element, _expand);
    });
    res.locals.data = chain.value();
    next();
  } // GET /name/:id
  // GET /name/:id?_embed=&_expand


  function show(req, res, next) {
    const _embed = req.query._embed;
    const _expand = req.query._expand;
    const resource = db.get(name).getById(req.params.id).value();

    if (resource) {
      // Clone resource to avoid making changes to the underlying object
      const clone = _.cloneDeep(resource); // Embed other resources based on resource id
      // /posts/1?_embed=comments


      embed(clone, _embed); // Expand inner resources based on id
      // /posts/1?_expand=user

      expand(clone, _expand);
      res.locals.data = clone;
    }

    next();
  } // POST /name
  // POST /name?_split=


  function create(req, res, next) {
    const {
      _split
    } = req.query;
    let resource;

    if (_split) {
      const {
        mainBody,
        relativeBodies
      } = split(req.body, _split);
      resource = _create(req, res, name, mainBody);
      const singularResource = pluralize.singular(name);
      const prop = `${singularResource}${opts.foreignKeySuffix}`;

      for (const _name in relativeBodies) {
        const body = relativeBodies[_name];
        const plural = pluralize(getRealResource(_name));

        if (Array.isArray(body)) {
          resource[_name] = body.map(body => {
            body[prop] = resource.id;

            if (body.id && db.get(plural).getById(body.id).value()) {
              return _update(req, res, body.id, plural, body);
            } else {
              return _create(req, res, plural, body);
            }
          });
        } else {
          body[prop] = resource.id;

          if (body.id && db.get(plural).getById(body.id).value()) {
            resource[_name] = _update(req, res, body.id, plural, body);
          } else {
            resource[_name] = _create(req, res, plural, body);
          }
        }
      }
    } else {
      resource = _create(req, res, name, req.body);
    }

    res.setHeader('Access-Control-Expose-Headers', 'Location');
    res.location(`${getFullURL(req)}/${resource.id}`);
    res.status(201);
    res.locals.data = resource;
    next();
  }

  function _create(req, res, name, body) {
    body = opts.effectWhenCreate({
      resource: name,
      data: body,
      req,
      res,
      db
    });

    if (opts._isFake) {
      const id = db.get(name).createId().value();
      return _objectSpread({}, body, {
        id
      });
    } else {
      return db.get(name).insert(body).cloneDeep().value();
    }
  } // PUT /name/:id
  // PATCH /name/:id
  // PUT /name/:id?_split=
  // PATCH /name/:id?_split=


  function update(req, res, next) {
    const {
      id,
      _split
    } = req.params;
    let resource;

    if (_split) {
      const {
        mainBody,
        relativeBodies
      } = split(req.body, _split);
      resource = _update(req, res, id, name, mainBody);
      const singularResource = pluralize.singular(name);
      const prop = `${singularResource}${opts.foreignKeySuffix}`;

      for (const _name in relativeBodies) {
        const body = relativeBodies[_name];
        const plural = pluralize(getRealResource(_name));

        if (Array.isArray(body)) {
          resource[_name] = body.map(body => {
            body[prop] = id;

            if (body.id && db.get(plural).getById(body.id).value()) {
              return _update(req, res, body.id, plural, body);
            } else {
              return _create(req, res, plural, body);
            }
          });
        } else {
          body[prop] = id;

          if (body.id && db.get(plural).getById(body.id).value()) {
            resource[_name] = _update(req, res, body.id, plural, body);
          } else {
            resource[_name] = _create(req, res, plural, body);
          }
        }
      }
    } else {
      resource = _update(req, res, id, name, req.body);
    }

    if (resource) {
      res.locals.data = resource;
    }

    next();
  }

  function _update(req, res, id, name, body) {
    body = opts.effectWhenUpdate({
      resource: name,
      data: body,
      req,
      res,
      db
    });
    let resource;

    if (opts._isFake) {
      resource = db.get(name).getById(id).value();

      if (req.method === 'PATCH') {
        resource = _objectSpread({}, resource, {}, body);
      } else {
        resource = _objectSpread({}, body, {
          id: resource.id
        });
      }
    } else {
      let chain = db.get(name);
      chain = req.method === 'PATCH' ? chain.updateById(id, body) : chain.replaceById(id, body);
      resource = chain.cloneDeep().value();
    }

    return resource;
  } // DELETE /name/:id


  function destroy(req, res, next) {
    opts.effectWhenDestroy({
      resource: name,
      id: req.params.id,
      req,
      res,
      db
    });
    let resource;

    if (opts._isFake) {
      resource = db.get(name).value();
    } else {
      resource = db.get(name).removeById(req.params.id).value(); // Remove dependents documents

      const removable = db._.getRemovable(db.getState(), opts);

      removable.forEach(item => {
        db.get(item.name).removeById(item.id).value();
      });
    }

    if (resource) {
      res.locals.data = {};
    }

    next();
  }

  const w = write(db);
  router.route('/').get(list).post(create, w);
  router.route('/:id').get(show).put(update, w).patch(update, w).delete(destroy, w);
  return router;
};