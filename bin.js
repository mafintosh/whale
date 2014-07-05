#!/usr/bin/env node

var tab = require('tabalot')
var relative = require('relative-date')
var pretty = require('prettysize')
var table = require('text-table')
var tar = require('tar-fs')
var dm = require('./')()

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
  dm.ps(function(err, list) {
    if (err) return cb(err)
    cb(null, list.map(toName))
  })
}

var images = function(cb) {
  dm.images(function(err, list) {
    if (err) return cb(err)
    cb(null, list.map(toName))
  })
}

tab('clean')
  (function() {
    dm.clean(onerror)
  })

tab('build')
  (images)
  (function(image) {
    if (!image) return onerror('Usage: dm build [image]')
    tar.pack('.').pipe(dm.build(image)).pipe(process.stdout)
  })

tab('ps')
  (function() {
    dm.ps(function(err, list) {
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
    dm.images(function(err, list) {
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
    dm.remove(image, onerror)
  })

tab('log')
  ('--all', '-a')
  (names)
  (function(name, opts) {
    dm.log(name, opts, function(err, stdout, stderr) {
      if (err) return onerror(err)
      stdout.pipe(process.stdout)
      stderr.pipe(process.stderr)
    })
  })

tab('stop')
  (names)
  (function(name) {
    dm.stop(name, onerror)
  })

tab('start')
  (images)
  (images)
  ('--no-log')
  ('--detach', '-d')
  (function(image, alias, opts) {
    if (!alias) alias = image

    var argv = opts['--'] || []
    var env = [].concat(opts.env || []).reduce(function(result, e) {
      e = e.trim().match(/^([^=]+)=(.*)$/)
      if (e) result[e[1]] = e[2]
      return result
    }, {})

    opts.argv = argv
    opts.image = image
    opts.env = env

    dm.start(alias || image, opts, function(err) {
      if (err) return onerror(err)
      if (opts.detach) return

      dm.log(alias, {all:true}, function(err, stdout, stderr) {
        if (err) return onerror(err)
        stdout.pipe(process.stdout)
        stderr.pipe(process.stderr)

        var stop = function() {
          dm.stop(alias, function() {
            process.exit(0)
          })
        }

        process.on('SIGTERM', stop)
        process.on('SIGINT', stop)
      })
    })
  })

tab.parse({'--':true}) || help()