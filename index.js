var docker = require('docker-remote-api')
var raw = require('docker-raw-stream')
var parse = require('through-json')
var duplexify = require('duplexify')
var pumpify = require('pumpify')
var through = require('through2')
var after = require('after-all')
var log = require('single-line-stream')
var xtend = require('xtend')

var parseName = function(name) {
  var parsed = name.match(/^(?:([^\/]+)\/)?([^@:]+)(?:[@:](.+))?$/).slice(1)
  var result = {
    name: parsed[1],
    repository: parsed[0],
    tag: parsed[2],
  }
  result.url = (result.repository ? result.repository+'/' : '') + result.name + (result.tag ? ':' + result.tag : '')
  return result
}

var buildStream = function() {
  return through.obj(function(data, enc, cb) {
    if (data.error) return cb(new Error(data.error.trim()))
    cb(null, data.stream)
  })
}

var progressStream = function() {
  var ids = []
  var messages = []

  return through.obj(function(data, enc, cb) {
    if (data.error) return cb(new Error(data.error.trim()))
    var i = data.id ? ids.lastIndexOf(data.id) : -1
    if (i === -1) i = ids.push(data.id)-1
    messages[i] = (data.id ? data.id + ' ' : '')+data.status+' '+(data.progress || '')
    cb(null, messages.join('\n')+'\n')
  })
}

var noop = function() {}

var encodeImage = function(img) {
  return img.replace(/:/g, '@')
}

var decodeImage = function(img) {
  return img.replace(/@/g, ':')
}

var encodeContainer = function(c) {
  return /^[a-zA-Z0-9_\-]+$/.test(c) ? c : 'whale-'+new Buffer(c).toString('hex')
}

var decodeContainer = function(c) {
  return /^whale-/.test(c) ? new Buffer(c.slice(6), 'hex').toString() : c
}

module.exports = function(remote, defaults) {
  if (typeof remote === 'object' && arguments.length === 1) return module.exports(null, remote)

  var request = docker(remote, defaults)
  var that = {}

  var toAuth = function(opts) {
    return {
      email: opts.email || defaults.email,
      username: opts.username || defaults.username,
      password: opts.password || defaults.password
    }
  }

  that.pull = function(image, opts) {
    if (!opts) opts = {}
    image = parseName(image, opts)

    var pull = pumpify()
    var post = request.post('/images/create', {
      qs: {
        repo: image.repository,
        fromImage: image.name,
        tag: image.tag,
        registry: opts.registry
      },
      headers: {
        'X-Registry-Auth': toAuth(opts)
      }
    }, function(err, response) {
      if (err) return pull.destroy(err)
      pull.setPipeline(response, parse(), progressStream(), log())
    })

    post.end()
    return pull
  }

  that.push = function(image, opts) {
    if (!opts) opts = {}
    image = parseName(image)

    var push = pumpify()
    var post = request.post('/images/'+(image.repository ? image.repository+'/' : '')+image.name+'/push', {
      qs: {
        registry: opts.registry,
        tag: image.tag
      },
      headers: {
        'X-Registry-Auth': toAuth(opts)
      }
    }, function(err, response) {
      if (err) return push.destroy(err)
      push.setPipeline(response, parse(), progressStream(), log())
    })

    post.end()
    return push
  }

  that.build = function(image, opts) {
    if (!opts) opts = {}
    image = parseName(image)

    var dup = duplexify()
    var post = request.post('/build', {
      qs: {
        t: image.url,
        nocache: opts.cache === false ? '1' : '0'
      },
      headers: {
        'Content-Type': 'application/tar'
      }
    }, function(err, response) {
      if (err) return dup.destroy(err)
      dup.setReadable(pumpify(response, parse(), buildStream()))
    })

    dup.setWritable(post)
    return dup
  }

  that.remove = function(image, cb) {
    if (!cb) cb = noop
    image = parseName(image)

    request.del('/images/'+image.url, {json: true}, function(err) {
      cb(err)
    })
  }

  that.images = function(cb) {
    request.get('/images/json', {json: true}, function(err, list) {
      if (err) return cb(err)

      var result = []

      list
        .filter(function(i) {
          return i.RepoTags.indexOf('<none>:<none>') === -1
        })
        .forEach(function(i) {
          var tags = i.RepoTags || []
          tags.forEach(function(tag) {
            result.push({
              id: i.Id,
              parent: i.ParentId,
              created: new Date(i.Created * 1000),
              name: encodeImage(tag).replace('@latest', ''),
              size: i.Size,
              virtualSize: i.VirtualSize
            })
          })
        })

      result.sort(function(a, b) {
        return a.name.localeCompare(b.name)
      })

      cb(null, result)
    })
  }

  that.ps = function(cb) {
    request.get('/containers/json', {json: true}, function(err, list) {
      if (err) return cb(err)

      list = list
        .filter(function(c) {
          return c.Names && c.Names.length
        })
        .map(function(c) {
          return {
            id: c.Id,
            created: new Date(c.Created * 1000),
            command: c.Command,
            name: decodeContainer(c.Names[0].slice(1)),
            image: encodeImage(c.Image).replace(/@latest$/, '')
          }
        })
        .sort(function(a, b) {
          return a.name.localeCompare(b.name)
        })

      cb(null, list)
    })
  }

  that.inspect = function(name, cb) {
    request.get('/containers/'+encodeContainer(name)+'/json', {json: true}, function(err, data) {
      if (err) return cb(err)

      var c = {
        id: data.Id.slice(0, 12),
        name: decodeContainer(data.Name.slice(1)),
        image: data.Config.Image || data.Image,
        command: (data.Config.Entrypoint || []).concat(data.Config.Cmd || []).join(' '),
        created: new Date(data.Created),
        network: data.HostConfig.NetworkMode,
        dns: data.HostConfig.Dns || [],
        volumes: data.Volumes || {},
        env: data.Config.Env.reduce(function(env, next) {
          next = next.match(/^([^=]+)=(.*)$/)
          if (!next) return env
          env[next[1]] = next[2]
          return env
        }, {})
      }

      if (data.HostConfig.NetworkMode === 'bridge') {
        c.ports = Object.keys(data.NetworkSettings.Ports || {}).reduce(function(result, name) {
          result[name.replace(/\/tcp$/, '')] = data.NetworkSettings.Ports[name][0].HostPort
          return result
        }, {})
      }

      cb(null, c)
    })
  }

  that.clean = function(cb) {
    if (!cb) cb = noop

    request.get('/images/json', {json: true}, function(err, images) {
      if (err) return cb(err)
      request.get('/containers/json', {json: true, qs: {all: true}}, function(err, list) {
        if (err) return cb(err)

        var next = after(cb)
        images.forEach(function(i) {
          if (i.RepoTags[0] === '<none>:<none>') that.remove(i.Id, next())
        })
        list.forEach(function(c) {
          var cb = next()
          request.get('/containers/'+c.Id+'/json', {json: true}, function(err, data) {
            if (err || !data) return cb(err)
            if (data.State.Running) return cb()
            request.del('/containers/'+c.Id, cb)
          })
        })
      })
    })
  }

  that.events = function(opts) {
    if (!opts) opts = {}

    var events = duplexify.obj()
    var names = {}

    var lookup = function(id, cb) {
      if (names[id]) return cb(names[id])
      that.inspect(id, function(err, data) {
        if (err) return cb(null)
        cb(names[id] = data.name)
      })
    }

    var map = through.obj(function(data, enc, cb) {
      var onname = function(name) {
        if (data.status === 'destroy') delete names[data.id]
        cb(null, {
          status: data.status,
          id: data.id.slice(0, 12),
          name: name,
          image: encodeImage(data.from).replace('@latest', ''),
          time: new Date(data.time * 1000)
        })
      }

      if (opts.name) lookup(data.id, onname)
      else onname(null)
    })

    request.get('/events', {agent: false}, function(err, response) {
      if (err) return events.destroy(err)
      events.setPipeline(response, parse(), map)
    })

    return events
  }

  that.log = function(name, opts) {
    if (!opts) opts = {}

    var log = raw()
    var post = request.post('/containers/'+encodeContainer(name)+'/attach', {
      agent: false,
      qs: {
        stdout: 1,
        stderr: 1,
        stream: 1,
        log: +!!opts.all
      }
    }, function(err, response) {
      if (err) return log.destroy(err)
      pump(response, log)
    })

    log.on('close', function() {
      post.destroy()
    })

    post.end()
    return log
  }

  that.start = function(name, opts, cb) {
    if (typeof opts === 'function') return that.start(name, null, opts)
    if (!opts) opts = {}
    if (!cb) cb = noop

    name = encodeContainer(name)

    var removeAndRetry = function() {
      if (opts.retry === false) return cb(new Error('Could not be start container'))
      request.post('/containers/'+name+'/kill', {body: null}, function() {
        request.del('/containers/'+name, function() {
          that.start(name, xtend(opts, {retry: false}), cb)
        })
      })
    }

    request.get('/containers/'+name+'/json', {json: true}, function(err, data) {
      if (err && err.statusCode !== 404) return cb(err)
      if (data && !data.State.Running) return removeAndRetry()
      if (data) return cb(opts.force ? null : new Error('Container is already running'))

      var sopts = {
        NetworkMode: opts.network || opts.ports && Object.keys(opts.ports).length ? 'bridge' : 'host',
        Binds: [],
        PortBindings: {}
      }

      var copts = {
        Image: decodeImage(opts.image || name),
        Cmd: opts.argv || [],
        Volumes: {},
        Env: [],
        ExposedPorts: {}
      }

      if (opts.dns) sopts.Dns = [].concat(opts.dns)

      if (opts.ports) {
        Object.keys(opts.ports).forEach(function(from) {
          var to = opts.ports[from]
          if (!/\//.test(from)) from += '/tcp'
          copts.ExposedPorts[from] = {}
          sopts.PortBindings[from] = [{HostPort:to+''}]
        })
      }

      if (opts.env) {
        Object.keys(opts.env).forEach(function(name) {
          copts.Env.push(name+'='+opts.env[name])
        })
      }

      if (opts.volumes) {
        Object.keys(opts.volumes).forEach(function(to) {
          var from = opts.volumes[to]
          copts.Volumes[to] = {}
          sopts.Binds.push(from+':'+to+':rw')
        })
      }

      request.post('/containers/create', {qs: {name: name}, json: copts}, function(err) {
        if (err) return cb(err)
        request.post('/containers/'+name+'/start', {json: sopts}, cb)
      })
    })
  }

  that.stop = function(name, opts, cb) {
    if (typeof opts === 'function') return that.stop(name, null, opts)
    if (!opts) opts = {}
    if (!cb) cb = noop

    name = encodeContainer(name)

    request.get('/containers/'+name+'/json', {json: true}, function(err) {
      if (err && err.statusCode === 404 && opts.force) return cb()
      if (err) return cb(err)
      request.post('/containers/'+name+'/stop', {body: null, qs: {t: opts.wait || 15}}, function(err) {
        if (err) return cb(err)
        request.del('/containers/'+name, cb)
      })
    })
  }

  that.ping = function(cb) {
    request.get('/_ping', {buffer:true}, function(err) {
      cb(err)
    })
  }

  return that
}