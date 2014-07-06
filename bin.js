#!/usr/bin/env node

var tab = require('tabalot')
var relative = require('relative-date')
var pretty = require('prettysize')
var table = require('text-table')
var tree = require('pretty-tree')
var tar = require('tar-fs')
var whale = require('./')()

var help = function() {
  console.error(require('fs').readFileSync(require('path').join(__dirname, 'help.txt'), 'utf-8'))
  process.exit(1)
}

var onerror = function(err) {
  if (!err) return
  console.error(err.message || err)
  process.exit(1)
}

var toName = function(c) {
  return c.name
}

var names = function(cb) {
  whale.ps(function(err, list) {
    if (err) return cb(err)
    cb(null, list.map(toName))
  })
}

var images = function(cb) {
  whale.images(function(err, list) {
    if (err) return cb(err)
    cb(null, list.map(toName))
  })
}

var attach = function(name, all, kill) {
  whale.log(name, {all:all}, function(err, stdout, stderr) {
    if (err) return onerror(err)

    stdout.pipe(process.stdout)
    stderr.pipe(process.stderr)

    if (!kill) return

    var stop = function() {
      whale.stop(name, function() {
        process.exit(0)
      })
    }

    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  })
}

tab('clean')
  (function() {
    whale.clean(onerror)
  })

tab('build')
  (images)
  (function(image) {
    if (!image) return onerror('Usage: whale build [image]')
    tar.pack('.').pipe(whale.build(image)).pipe(process.stdout)
  })

tab('ps')
  (function() {
    whale.ps(function(err, list) {
      if (err) return onerror(err)

      list = list.map(function(c) {
        return [
          c.name,
          c.id.slice(0, 12),
          c.image,
          c.command,
          relative(c.created),
          c.status
        ]
      })

      list.unshift(['NAME', 'ID', 'IMAGE', 'COMMAND', 'CREATED', 'STATUS'])
      console.log(table(list, {hsep:'    '}))
    })
  })

tab('images')
  (function() {
    whale.images(function(err, list) {
      if (err) return onerror(err)

      list = list.map(function(i) {
        return [
          i.name,
          i.id.slice(0, 12),
          i.parent.slice(0, 12),
          relative(i.created),
          pretty(i.virtualSize)
        ]
      })

      list.unshift(['NAME', 'ID', 'PARENT ID', 'CREATED', 'VIRTUAL SIZE'])
      console.log(table(list, {hsep:'    '}))
    })
  })

tab('remove')
  (images)
  (function(image) {
    if (!image) return onerror('Usage: whale remove [image]')
    whale.remove(image, onerror)
  })

tab('log')
  ('--all', '-a')
  (names)
  (function(name, opts) {
    if (!name) return onerror('Usage: whale log [name]')
    attach(name, opts.all, false)
  })

tab('info')
  (names)
  (function(name, opts) {
    if (!name) return onerror('Usage: whale info [name]')

    whale.info(name, function(err, info) {
      if (err) return onerror(err)

      var name = info.name
      delete info.name
      info.created = relative(info.created)

      console.log(tree.plain({
        label: name,
        leaf: info
      }))
    })
  })

tab('restart')
  ('--attach', '-a')
  (names)
  (function(name, opts) {
    if (!name) return onerror('Usage: whale restart [name]')

    whale.restart(name, function(err) {
      if (err) return onerror(err)
      if (opts.attach) attach(name, true, true)
    })
  })

tab('stop')
  (names)
  (function(name) {
    if (!name) return onerror('Usage: whale stop [name]')
    whale.stop(name, onerror)
  })

tab('start')
  ('--volume', '-v', '@dir')
  ('--detach', '-d')
  ('--env', '-e')
  (images)
  (images)
  (function(image, name, opts) {
    if (!image) return onerror('Usage: whale start [image] [name?]')
    if (!name) name = image

    var log = opts.log || !opts.detach
    var argv = opts['--'] || []

    var env = [].concat(opts.env || []).reduce(function(result, e) {
      e = e.trim().match(/^([^=]+)=(.*)$/)
      if (e) result[e[1]] = e[2]
      return result
    }, {})

    var volumes = [].concat(opts.volume || []).reduce(function(result, v) {
      v = v.split(':')
      result[v[0]] = v[1] || v[0]
      return result
    }, {})

    opts.argv = argv
    opts.image = image
    opts.env = env
    opts.volumes = volumes

    whale.start(name, opts, function(err) {
      if (err) return onerror(err)
      if (!opts.detach) attach(name, true, true)
    })
  })

tab.parse({'--':true}) || help()