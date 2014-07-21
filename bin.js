#!/usr/bin/env node

var tab = require('tabalot')
var relative = require('relative-date')
var pretty = require('prettysize')
var table = require('text-table')
var tree = require('pretty-tree')
var dateable = require('dateable')
var tar = require('tar-fs')
var fs = require('fs')
var path = require('path')
var ignore = require('ignore-file')

var CONF = path.join(process.env.HOME || process.env.USERPROFILE, '.dockercfg')
var AUTH = fs.existsSync(CONF) && JSON.parse(fs.readFileSync(CONF))['https://index.docker.io/v1/']

if (AUTH) {
  var parts = new Buffer(AUTH.auth, 'base64').toString().split(':')
  AUTH.username = parts[0]
  AUTH.password = parts[1]
}

var whale = require('./')(AUTH)

var help = function(name) {
  console.log(fs.readFileSync(path.join(__dirname, 'docs', name+'.txt'), 'utf-8'))
  process.exit(0)
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
  var log = whale.log(name, {all: all})

  log.on('error', onerror)
  log.stdout.pipe(process.stdout)
  log.stderr.pipe(process.stderr)

  if (!kill) return

  var stop = function() {
    whale.stop(name, function() {
      process.exit(0)
    })
  }

  log.on('end', stop)
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

tab('*')
  ('--help', '-h', '-?')

tab('clean')
  (function(opts) {
    if (opts.help) return help('clean')
    whale.clean(onerror)
  })

tab('tag')
  ('--rename', '-r')
  (images)
  (images)
  (function(image, repo, opts) {
    if (!image || !repo || opts.help) return help('tag')
    whale.tag(image, repo, opts, onerror)
  })

tab('pull')
  (images)
  (function(image, opts) {
    if (!image || opts.help) return help('pull')
    whale.pull(image, opts).on('error', onerror).pipe(process.stdout)
  })

tab('push')
  (images)
  (images)
  (function(image, tag, opts) {
    if (!image || opts.help) return help('push')
    whale.push(image, tag, opts).on('error', onerror).pipe(process.stdout)
  })

tab('build')
  ('--no-cache')
  ('--no-ignore')
  (images)
  (function(image, opts) {
    if (!image || opts.help) return help('build')
    var filter = opts.ignore !== false && (ignore.sync('.dockerignore') || ignore.sync('.gitignore'))
    tar.pack('.', {ignore:filter}).pipe(whale.build(image, opts)).on('error', onerror).pipe(process.stdout)
  })

tab('ps')
  (function(opts) {
    if (opts.help) return help('ps')
    whale.ps(function(err, list) {
      if (err) return onerror(err)

      list = list.map(function(c) {
        return [
          c.name,
          c.id.slice(0, 12),
          c.image,
          c.command,
          relative(c.created)
        ]
      })

      list.unshift(['NAME', 'ID', 'IMAGE', 'COMMAND', 'CREATED'])
      console.log(table(list, {hsep: '    '}))
    })
  })

tab('events')
  (function(opts) {
    if (opts.help) return help('events')
    whale.events({name:true}).on('data', function(data) {
      var name = data.name || data.id
      if (name !== data.image) name += ' (from '+data.image+')'
      console.log(dateable(data.time, 'YYYY-MM-DD hh:mm:ss')+' - '+name+' '+': '+data.status)
    })
  })

tab('images')
  (function(opts) {
    if (opts.help) return help('images')
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
      console.log(table(list, {hsep: '    '}))
    })
  })

tab('remove')
  (images)
  (function(image, opts) {
    if (!image || opts.help) return help('remove')
    whale.remove(image, onerror)
  })

tab('log')
  ('--all', '-a')
  (names)
  (function(name, opts) {
    if (!name || opts.help) return help('log')
    attach(name, opts.all, false)
  })

tab('inspect')
  (names)
  (function(name, opts) {
    if (!name || opts.help) return help('inspect')

    whale.inspect(name, function(err, info) {
      if (err) return onerror(err)

      var name = info.name
      delete info.name
      info.created = relative(info.created)
      info.id = info.id.slice(0, 12)

      console.log(tree.plain({
        label: name,
        leaf: info
      }))
    })
  })

tab('stop')
  ('--force')
  (names)
  (function(name, opts) {
    if (!name || opts.help) return help('stop')
    whale.stop(name, onerror)
  })

tab('start')
  ('--volume', '-v', '@dir')
  ('--fork', '-f')
  ('--force')
  ('--dns', '-d')
  ('--env', '-e')
  ('--port', '-p')
  ('--network', '-n', ['host', 'bridge', 'none'])
  (images)
  (images)
  (function(image, name, opts) {
    if (!image || opts.help) return help('start')
    if (!name) name = image

    var log = opts.log || !opts.detach
    var argv = opts['--'] || []

    var ports = [].concat(opts.port || []).reduce(function(result, p) {
      p = p.toString().split(':')
      result[p[0]] = p[1] || p[0]
      return result
    }, {})

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
    opts.ports = ports

    whale.start(name, opts, function(err) {
      if (err) return onerror(err)
      if (!opts.fork) attach(name, true, true)
    })
  })

tab.parse({'--':true}) || help('usage')