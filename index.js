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

var manager = function(url) {
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

  that.start = function(name, opts, cb) {
    if (typeof opts === 'function') return that.start(name, null, opts)
    if (!opts) opts = {}
    if (!cb) cb = noop

    if (!opts.network) opts.network = 'host'

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
      if (data) return cb(new Error('Container already exists'))

      var c = {
        name: name,
        Image: decodeImage(opts.image || name),
        Cmd: opts.argv || []
      }

      docker.createContainer(c, function(err) {
        if (err) return cb(err)
        docker.getContainer(name).start({NetworkMode:opts.network}, function(err) {
          cb(err)
        })
      })
    })
  }

  that.stop = function(name, opts, cb) {
    if (typeof opts === 'function') return that.stop(name, null, opts)
    if (!opts) opts = {}
    if (!cb) cb = noop

    lookup(name, function(err, data, c) {
      if (err) return cb(err)
      if (!data) return cb(new Error('Container does not exist'))

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

    var onstream = function(err, stream) {
      if (err) return cb(err)
      var r = raw()
      stream.pipe(r)
      cb(null, r.stdout, r.stderr)
    }

    var dopts = {stdout:true, stderr:true, stream:true, follow:true}

    lookup(name, function(err, data, c) {
      if (err) return cb(err)
      if (!data) return cb(new Error('Container does not exist'))

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
    return build({tag:image})
  }

  that.remove = function(image, cb) {
    docker.getImage(decodeImage(image)).remove(function(err) {
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
              name: tag.replace(':', '@').replace('@latest', ''),
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
            name: c.Names[0].slice(1),
            image: encodeImage(c.Image),
            status: c.Status
          }
        })

      cb(null, list)
    })
  }

  return that
}

module.exports = manager