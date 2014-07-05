#!/usr/bin/env node

var tab = require('tabalot')
var relative = require('relative-date')
var pretty = require('prettysize')
var table = require('text-table')
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
    whale.log(name, opts, function(err, stdout, stderr) {
      if (err) return onerror(err)
      stdout.pipe(process.stdout)
      stderr.pipe(process.stderr)
    })
  })

tab('restart')
  (names)
  (function(name) {
    if (!name) return onerror('Usage: whale restart [name]')
    whale.restart(name, onerror)
  })

tab('stop')
  (names)
  (function(name) {
    if (!name) return onerror('Usage: whale stop [name]')
    whale.stop(name, onerror)
  })

tab('start')
  (images)
  (images)
  ('--detach', '-d')
  (function(image, name, opts) {
    if (!image) return onerror('Usage: whale start [image] [name?]')
    if (!name) name = image

    var argv = opts['--'] || []
    var env = [].concat(opts.env || []).reduce(function(result, e) {
      e = e.trim().match(/^([^=]+)=(.*)$/)
      if (e) result[e[1]] = e[2]
      return result
    }, {})

    opts.argv = argv
    opts.image = image
    opts.env = env

    whale.start(name, opts, function(err) {
      if (err) return onerror(err)
      if (opts.detach) return

      whale.log(name, {all:true}, function(err, stdout, stderr) {
        if (err) return onerror(err)
        stdout.pipe(process.stdout)
        stderr.pipe(process.stderr)

        var stop = function() {
          whale.stop(name, function() {
            process.exit(0)
          })
        }

        process.on('SIGTERM', stop)
        process.on('SIGINT', stop)
      })
    })
  })

tab.parse({'--':true}) || help()