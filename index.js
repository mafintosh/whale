var events = require('events')
var dockerode = require('dockerode')
var host = require('docker-host')
var raw = require('docker-raw-stream')
var build = require('docker-build')
var after = require('after-all')

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

var whale = function(url) {
  url = host(url)
  if (url.host) url.host = 'http://'+url.host

  var docker = dockerode(url)

  var lookup = function(name, cb) {
    var c = docker.getContainer(name)
    c.inspect(function(err, data) {
      if (err) return cb(err.statusCode === 404 ? null : err, null, null)
      cb(null, data, c)
    })
  }

  var that = {}

  that.restart = function(name, opts, cb) {
    if (typeof opts === 'function') return that.restart(name, null, opts)
    if (!opts) opts = {}
    if (!cb) cb = noop

    lookup(encodeContainer(name), function(_, data) {
      if (data && data.Image) opts.image = opts.image || data.Image
      that.stop(name, opts, function(err) {
        if (err) return cb(err)
        that.start(name, opts, cb)
      })
    })
  }

  that.inspect = function(name, opts, cb) {
    if (typeof opts === 'function') return that.inspect(name, null, opts)
    if (!opts) opts = {}

    lookup(encodeContainer(name), function(err, data) {
      if (err) return cb(err)
      if (!data) return cb(new Error('Container is not running'))

      var c = {
        id: data.Id.slice(0, 12),
        name: decodeContainer(data.Name.slice(1)),
        image: data.Config.Image || data.Image,
        command: (data.Config.Entrypoint || []).concat(data.Config.Cmd || []).join(' '),
        created: new Date(data.Created),
        network: data.HostConfig.NetworkMode,
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

  that.start = function(name, opts, cb) {
    if (typeof opts === 'function') return that.start(name, null, opts)
    if (!opts) opts = {}
    if (!cb) cb = noop

    name = encodeContainer(name)

    var removeAndStart = function() {
      var c = docker.getContainer(name)
      c.kill(function() {
        c.remove(function() {
          that.start(name, opts, cb)
        })
      })
    }

    lookup(name, function(err, data) {
      if (err) return cb(err)
      if (data && !data.State.Running) return removeAndStart()
      if (data) return cb(new Error('Container is already running'))

      var sopts = {
        NetworkMode: opts.network || opts.ports && Object.keys(opts.ports).length ? 'bridge' : 'host',
        Binds: [],
        PortBindings: {}
      }

      var copts = {
        name: name,
        Image: decodeImage(opts.image || name),
        Cmd: opts.argv || [],
        Volumes: {},
        Env: [],
        ExposedPorts: {}
      }

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

      docker.createContainer(copts, function(err) {
        if (err) return cb(err)
        docker.getContainer(name).start(sopts, function(err) {
          cb(err)
        })
      })
    })
  }

  that.stop = function(name, opts, cb) {
    if (typeof opts === 'function') return that.stop(name, null, opts)
    if (!opts) opts = {}
    if (!cb) cb = noop

    name = encodeContainer(name)

    lookup(name, function(err, data, c) {
      if (err) return cb(err)
      if (!data) return cb(new Error('Container is not running'))

      c.stop({t:30}, function(err) {
        if (err) return cb(err)
        c.remove(function(err) {
          cb(err)
        })
      })
    })
  }

  that.log = function(name, opts, cb) {
    if (typeof opts === 'function') return that.log(name, null, opts)
    if (!opts) opts = {}

    name = encodeContainer(name)

    var onstream = function(err, stream) {
      if (err) return cb(err)
      var r = raw()
      stream.pipe(r)
      cb(null, r.stdout, r.stderr)
    }

    var dopts = {stdout:true, stderr:true, stream:true, follow:true}

    lookup(name, function(err, data, c) {
      if (err) return cb(err)
      if (!data) return cb(new Error('Container is not running'))

      if (opts.all) c.logs(dopts, onstream)
      else c.attach(dopts, onstream)
    })
  }

  that.clean = function(cb) {
    if (!cb) cb = noop

    docker.listImages(function(err, images) {
      if (err) return cb(err)
      docker.listContainers({all:true}, function(err, list) {
        if (err) return cb(err)

        var next = after(cb)

        images.forEach(function(i) {
          if (i.RepoTags[0] === '<none>:<none>') docker.getImage(i.Id).remove(next())
        })

        list.forEach(function(c) {
          var cb = next()
          lookup(c.Id, function(err, data, c) {
            if (err || !data) return cb(err)
            if (data.State.Running) return cb()
            c.remove(cb)
          })
        })
      })
    })
  }

  that.build = function(image) {
    image = decodeImage(image)
    return build({tag:image})
  }

  that.remove = function(image, cb) {
    image = decodeImage(image)
    docker.getImage(image).remove(function(err) {
      cb(err)
    })
  }

  that.images = function(cb) {
    docker.listImages(function(err, list) {
      if (err) return cb(err)

      var result = []

      list = list
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

      cb(null, result)
    })
  }

  that.ps = function(cb) {
    docker.listContainers(function(err, list) {
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
            image: encodeImage(c.Image).replace(/@latest$/, ''),
            status: c.Status
          }
        })

      cb(null, list)
    })
  }

  return that
}

module.exports = whale