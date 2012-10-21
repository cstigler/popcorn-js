(function( Popcorn, window, document ) {

  var

  CURRENT_TIME_MONITOR_MS = 10,
  SEEK_MONITOR_MS = 250,
  EMPTY_STRING = "",

  // YouTube suggests 200x200 as minimum, video spec says 300x150.
  MIN_WIDTH = 300,
  MIN_HEIGHT = 200,

  // Example: http://www.youtube.com/watch?v=12345678901
  regexYouTube = /^.*(?:\/|v=)(.{11})/,

  ABS = Math.abs,

  // Setup for YouTube API
  ytReady = false,
  ytLoaded = false,
  ytCallbacks = [];

  var callbackQueue = function() {
    var _queue = [],
        _running = false;

    return {
      next: function() {
        _running = false;
        _queue.shift();
        _queue[ 0 ] && _queue[ 0 ]();
      },
      add: function( callback ) {
        _queue.push(function() {
          _running = true;
          callback && callback();
        });

        // if there is only one item on the queue, start it
        !_running && _queue[ 0 ]();
      }
    };
  };

  function isYouTubeReady() {
    // If the YouTube iframe API isn't injected, to it now.
    if( !ytLoaded ) {
      var tag = document.createElement( "script" );
      var protocol = window.location.protocol === "file:" ? "http:" : "";

      tag.src = protocol + "//www.youtube.com/iframe_api";
      var firstScriptTag = document.getElementsByTagName( "script" )[ 0 ];
      firstScriptTag.parentNode.insertBefore( tag, firstScriptTag );
      ytLoaded = true;
    }
    return ytReady;
  }

  function addYouTubeCallback( callback ) {
    ytCallbacks.unshift( callback );
  }

  // An existing YouTube references can break us.
  // Remove it and use the one we can trust.
  if ( window.YT ) {
    window.quarantineYT = window.YT;
    window.YT = null;
  }

  window.onYouTubeIframeAPIReady = function() {
    ytReady = true;
    var i = ytCallbacks.length;
    while( i-- ) {
      ytCallbacks[ i ]();
      delete ytCallbacks[ i ];
    }
  };

  function HTMLYouTubeVideoElement( id ) {

    // YouTube iframe API requires postMessage
    if( !window.postMessage ) {
      throw "ERROR: HTMLYouTubeVideoElement requires window.postMessage";
    }

    var self = this,
      parent = typeof id === "string" ? document.querySelector( id ) : id,
      elem,
      impl = {
        src: EMPTY_STRING,
        networkState: self.NETWORK_EMPTY,
        readyState: self.HAVE_NOTHING,
        seeking: false,
        autoplay: EMPTY_STRING,
        preload: EMPTY_STRING,
        controls: false,
        loop: false,
        poster: EMPTY_STRING,
        volume: -1,
        muted: false,
        currentTime: 0,
        duration: NaN,
        ended: false,
        paused: true,
        width: '100%',
        height: '100%',
        error: null
      },
      playerReady = false,
      player,
      playerReadyCallbacks = [],
      playerState = -1,
      bufferedInterval,
      lastLoadedFraction = 0,
      currentTimeInterval,
      seekEps = 0.1,
      timeUpdateInterval,
      firstPlay = true,
      actionQueue = callbackQueue(),
      seekMonitorInterval,
      forcedLoadMetadata = false;

    // Namespace all events we'll produce
    self._eventNamespace = Popcorn.guid( "HTMLYouTubeVideoElement::" );

    self.parentNode = parent;

    // Mark this as YouTube
    self._util.type = "YouTube";

    function addPlayerReadyCallback( callback ) {
      playerReadyCallbacks.unshift( callback );
    }

    function onPlayerReady( event ) {
      playerReady = true;
      self.play();
    }

    // YouTube sometimes sends a duration of 0.  From the docs:
    // "Note that getDuration() will return 0 until the video's metadata is loaded,
    // which normally happens just after the video starts playing."
    function forceLoadMetadata() {
      if( !forcedLoadMetadata ) {
        forcedLoadMetadata = true;
        self.play();
        self.pause();
      }
    }

    function getDuration() {
      if( !playerReady ) {
        // Queue a getDuration() call so we have correct duration info for loadedmetadata
        addPlayerReadyCallback( function() { getDuration(); } );
        return impl.duration;
      }

      var oldDuration = impl.duration,
          newDuration = player.getDuration();

      // Deal with duration=0 from YouTube
      if( newDuration ) {
        if( oldDuration !== newDuration ) {
          impl.duration = newDuration;
          self.dispatchEvent( "durationchange" );
        }
      } else {
        // Force loading metadata, and wait on duration>0
        forceLoadMetadata();
        setTimeout( getDuration, 50 );
      }

      return newDuration;
    }

    function onPlayerError(event) {
      // There's no perfect mapping to HTML5 errors from YouTube errors.
      var err = { name: "MediaError" };

      switch( event.data ) {

        // invalid parameter
        case 2:
          err.message = "Invalid video parameter.";
          err.code = MediaError.MEDIA_ERR_ABORTED;
          break;

        // HTML5 Error
        case 5:
          err.message = "The requested content cannot be played in an HTML5 player or another error related to the HTML5 player has occurred.";
          err.code = MediaError.MEDIA_ERR_DECODE;

        // requested video not found
        case 100:
          err.message = "Video not found.";
          err.code = MediaError.MEDIA_ERR_NETWORK;
          break;

        // video can't be embedded by request of owner
        case 101:
        case 150:
          err.message = "Video not usable.";
          err.code = MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED;
          break;

        default:
          err.message = "Unknown error.";
          err.code = 5;
      }

      impl.error = err;
      self.dispatchEvent( "error" );
    }

    function onPlayerStateChange( event ) {
      switch( event.data ) {

        // unstarted
        case -1:
          break;

        // ended
        case YT.PlayerState.ENDED:
          onEnded();
          break;

        // playing
        case YT.PlayerState.PLAYING:
          if( firstPlay ) {
            firstPlay = false;

            // XXX: this should really live in cued below, but doesn't work.
            impl.readyState = self.HAVE_METADATA;
            self.dispatchEvent( "loadedmetadata" );
            if (!playerReady) {
              addPlayerReadyCallback( function() {
                bufferedInterval = setInterval( monitorBuffered, 50 );
              });
            } else {
              bufferedInterval = setInterval( monitorBuffered, 50 );
            }

            self.dispatchEvent( "loadeddata" );

            impl.readyState = self.HAVE_FUTURE_DATA;
            self.dispatchEvent( "canplay" );

            // We can't easily determine canplaythrough, but will send anyway.
            impl.readyState = self.HAVE_ENOUGH_DATA;
            self.dispatchEvent( "canplaythrough" );

            // Pause video if we aren't auto-starting
            if( !impl.autoplay ) {
              actionQueue.next();
              player.pauseVideo();
            } else {
              // This is a real play as well as a ready event
              onPlay();
            }

            var i = playerReadyCallbacks.length;
            while( i-- ) {
              playerReadyCallbacks[ i ]();
              delete playerReadyCallbacks[ i ];
            }
          } else {
            onPlay();
          }
          break;

        // paused
        case YT.PlayerState.PAUSED:
          onPause();
          break;

        // buffering
        case YT.PlayerState.BUFFERING:
          impl.networkState = self.NETWORK_LOADING;
          self.dispatchEvent( "waiting" );
          break;

        // video cued
        case YT.PlayerState.CUED:
          // XXX: cued doesn't seem to fire reliably, bug in youtube api?
          break;
      }

      if (event.data !== YT.PlayerState.BUFFERING && playerState === YT.PlayerState.BUFFERING) {
        onProgress();
      }

      playerState = event.data;
    }

    function destroyPlayer() {
      if( !( playerReady && player ) ) {
        return;
      }
      clearInterval( currentTimeInterval );
      clearInterval( bufferedInterval );
      player.stopVideo();
      player.clearVideo();

      parent.removeChild( elem );
      elem = null;
    }

    function changeSrc( aSrc ) {
      if( !self._canPlaySrc( aSrc ) ) {
        impl.error = {
          name: "MediaError",
          message: "Media Source Not Supported",
          code: MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED
        };
        self.dispatchEvent( "error" );
        return;
      }

      impl.src = aSrc;

      // Make sure YouTube is ready, and if not, register a callback
      if( !isYouTubeReady() ) {
        addYouTubeCallback( function() { changeSrc( aSrc ); } );
        return;
      }

      if( playerReady ) {
        destroyPlayer();
      }

      elem = document.createElement( "div" );
      elem.width = impl.width;
      elem.height = impl.height;
      parent.appendChild( elem );

      // Use any player vars passed on the URL
      var playerVars = self._util.parseUri( aSrc ).queryKey;

      // Remove the video id, since we don't want to pass it
      delete playerVars.v;

      // Sync autoplay, but manage internally
      impl.autoplay = playerVars.autoplay === "1" || impl.autoplay;
      delete playerVars.autoplay;

      // Sync loop, but manage internally
      impl.loop = playerVars.loop === "1" || impl.loop;
      delete playerVars.loop;

      // Don't show related videos when ending
      playerVars.rel = playerVars.rel || 0;

      // Don't show YouTube's branding
      playerVars.modestbranding = playerVars.modestbranding || 1;

      // Don't show annotations by default
      playerVars.iv_load_policy = playerVars.iv_load_policy || 3;

      // Don't show video info before playing
      playerVars.showinfo = playerVars.showinfo || 0;

      // Specify our domain as origin for iframe security
      var domain = window.location.protocol === "file:" ? "*" :
        window.location.protocol + "//" + window.location.host;
      playerVars.origin = playerVars.origin || domain;

      // Show/hide controls. Sync with impl.controls and prefer URL value.
      playerVars.controls = playerVars.controls || impl.controls ? 2 : 0;
      impl.controls = playerVars.controls;

      // Get video ID out of youtube url
      aSrc = regexYouTube.exec( aSrc )[ 1 ];

      player = new YT.Player( elem, {
        width: impl.width,
        height: impl.height,
        videoId: aSrc,
        playerVars: playerVars,
        events: {
          'onReady': onPlayerReady,
          'onError': onPlayerError,
          'onStateChange': onPlayerStateChange
        }
      });

      impl.networkState = self.NETWORK_LOADING;
      self.dispatchEvent( "loadstart" );
      self.dispatchEvent( "progress" );

      // Queue a get duration call so we'll have duration info
      // and can dispatch durationchange.
      forcedLoadMetadata = false;
      getDuration();
    }

    function monitorCurrentTime() {
      var playerTime = player.getCurrentTime();

      if ( !impl.seeking ) {
        impl.currentTime = playerTime;

        // the multiplication by two is just to give a tiny bit of leeway, since JS events are imprecise
        if( ABS( impl.currentTime - playerTime ) > CURRENT_TIME_MONITOR_MS * 2 ) {
          // User seeked the video via controls
          onSeeking();
          onSeeked();
        }
      }
    }

    function monitorBuffered() {
      var fraction = player.getVideoLoadedFraction();

      if ( lastLoadedFraction !== fraction ) {
        lastLoadedFraction = fraction;

        onProgress();

        if (fraction >= 1) {
          clearInterval( bufferedInterval );
        }
      }
    }

    // we don't need to monitor seeks as often as currentTime, so a different loop is better
    function monitorSeek() {
      var playerTime = player.getCurrentTime();

      if ( impl.seeking ) {
        if ( impl.currentTime >= playerTime - seekEps && impl.currentTime <= playerTime + seekEps ) {
          // seek succeeded
          onSeeked();
        } else {
          // seek failed, try again with higher tolerance
          seekEps *= 2;
          player.seekTo ( impl.currentTime );
        }
      }
    }

    function changeCurrentTime( aTime ) {
      if( !playerReady ) {
        addPlayerReadyCallback( function() { changeCurrentTime( aTime ); } );
        return;
      }

      aTime = Number( aTime );
      if ( isNaN ( aTime ) ) {
        return;
      }

      impl.currentTime = aTime;

      onSeeking( aTime );
      player.seekTo( aTime );
    }

    function onTimeUpdate() {
      self.dispatchEvent( "timeupdate" );
    }

    function onSeeking() {
      impl.seeking = true;
      self.dispatchEvent( "seeking" );
      
      // start monitorCurrentTime interval in case we haven't played yet
      if ( !currentTimeInterval ) {
        currentTimeInterval = setInterval( monitorCurrentTime, CURRENT_TIME_MONITOR_MS );
      }

      if ( !seekMonitorInterval ) {
        seekMonitorInterval = setInterval( monitorSeek, SEEK_MONITOR_MS );
      }
    }

    function onSeeked() {
      impl.seeking = false;
      seekEps = 0.15;
      self.dispatchEvent( "timeupdate" );
      self.dispatchEvent( "seeked" );
      self.dispatchEvent( "canplay" );
      self.dispatchEvent( "canplaythrough" );
      clearInterval( seekMonitorInterval );
      seekMonitorInterval = null;
    }

    function onPlay() {
      // We've called play once (maybe through autoplay),
      // no need to force it from now on.
      forcedLoadMetadata = true;

      if( impl.ended ) {
        changeCurrentTime( 0 );
      }

      if ( !currentTimeInterval ) {
        currentTimeInterval = setInterval( monitorCurrentTime,
                                           CURRENT_TIME_MONITOR_MS ) ;

        // Only 1 play when video.loop=true
        if ( impl.loop ) {
          self.dispatchEvent( "play" );
        }
      }

      timeUpdateInterval = setInterval( onTimeUpdate,
                                        self._util.TIMEUPDATE_MS );

      if( impl.paused ) {
        impl.paused = false;

        // Only 1 play when video.loop=true
        if ( !impl.loop ) {
          self.dispatchEvent( "play" );
        }
        self.dispatchEvent( "playing" );
      }
      
      actionQueue.next();
    }

    function onProgress() {
      self.dispatchEvent( "progress" );
    }

    self.play = function() {
      if( !playerReady ) {
        addPlayerReadyCallback( function() { self.play(); } );
        return;
      }

      actionQueue.add(function() {
        if ( player.getPlayerState() !== 1 ) {
          seeking = false;
          player.playVideo();
        } else {
          actionQueue.next();
        }
      });
    };

    function onPause() {
      impl.paused = true;
      clearInterval( timeUpdateInterval );
      timeUpdateInterval = null;
      self.dispatchEvent( "pause" );
      
      actionQueue.next();
    }

    self.pause = function() {
      if( !playerReady ) {
        addPlayerReadyCallback( function() { self.pause(); } );
        return;
      }

      actionQueue.add(function() {
        if ( player.getPlayerState() !== 2 ) {
          seeking = false;
          player.pauseVideo();
        } else {
          actionQueue.next();
        }
      });
    };

    function onEnded() {
      if( impl.loop ) {
        changeCurrentTime( 0 );
        self.play();
      } else {
        impl.ended = true;
        self.dispatchEvent( "ended" );
      }
    }

    function setVolume( aValue ) {
      impl.volume = aValue;
      
      if( !playerReady ) {
        addPlayerReadyCallback( function() {
          setVolume( impl.volume );
        });
        return;
      }
      player.setVolume( aValue );

      // YouTube doesn't update volume immediately
      setTimeout( function() {
        self.dispatchEvent( "volumechange" )
      }, 10 );
    }

    function getVolume() {
      if( !playerReady ) {
        return impl.volume > -1 ? impl.volume : 100;
      }
      return player.getVolume();
    }

    function setMuted( aValue ) {
      impl.muted = aValue;

      if( !playerReady ) {
        addPlayerReadyCallback( function() { setMuted( impl.muted ); } );
        return;
      }
      player[ aValue ? "mute" : "unMute" ]();

      // YouTube doesn't update volume immediately
      setTimeout( function() {
        self.dispatchEvent( "volumechange" )
      }, 10 );
    }

    function getMuted() {
      // YouTube has isMuted(), but for sync access we use impl.muted
      return impl.muted;
    }

    Object.defineProperties( self, {

      src: {
        get: function() {
          return impl.src;
        },
        set: function( aSrc ) {
          if( aSrc && aSrc !== impl.src ) {
            changeSrc( aSrc );
          }
        }
      },

      autoplay: {
        get: function() {
          return impl.autoplay;
        },
        set: function( aValue ) {
          impl.autoplay = self._util.isAttributeSet( aValue );
        }
      },

      loop: {
        get: function() {
          return impl.loop;
        },
        set: function( aValue ) {
          impl.loop = self._util.isAttributeSet( aValue );
        }
      },

      width: {
        get: function() {
          return elem ? elem.width : 0;
        },
        set: function( aValue ) {
          impl.width = aValue;
        }
      },

      height: {
        get: function() {
          return elem ? elem.height : 0;
        },
        set: function( aValue ) {
          impl.height = aValue;
        }
      },

      currentTime: {
        get: function() {
          return impl.currentTime;
        },
        set: function( aValue ) {
          changeCurrentTime( aValue );
        }
      },

      duration: {
        get: function() {
          return getDuration();
        }
      },

      ended: {
        get: function() {
          return impl.ended;
        }
      },

      paused: {
        get: function() {
          return impl.paused;
        }
      },

      seeking: {
        get: function() {
          return impl.seeking;
        }
      },

      readyState: {
        get: function() {
          return impl.readyState;
        }
      },

      networkState: {
        get: function() {
          return impl.networkState;
        }
      },

      volume: {
        get: function() {
          // Remap from HTML5's 0-1 to YouTube's 0-100 range
          var volume = getVolume();
          return volume / 100;
        },
        set: function( aValue ) {
          if( aValue < 0 || aValue > 1 ) {
            throw "Volume value must be between 0.0 and 1.0";
          }

          // Remap from HTML5's 0-1 to YouTube's 0-100 range
          aValue = aValue * 100;
          setVolume( aValue );
        }
      },

      muted: {
        get: function() {
          return getMuted();
        },
        set: function( aValue ) {
          setMuted( self._util.isAttributeSet( aValue ) );
        }
      },

      error: {
        get: function() {
          return impl.error;
        }
      },

      buffered: {
        get: function () {
          var timeRanges = {
            start: function( index ) {
              if (index === 0) {
                return 0;
              }

              //throw fake DOMException/INDEX_SIZE_ERR
              throw "INDEX_SIZE_ERR: DOM Exception 1";
            },
            end: function( index ) {
              var duration;
              if (index === 0) {
                duration = getDuration();
                if (!duration) {
                  return 0;
                }

                return duration * player.getVideoLoadedFraction();
              }

              //throw fake DOMException/INDEX_SIZE_ERR
              throw "INDEX_SIZE_ERR: DOM Exception 1";
            }
          };

          Object.defineProperties( timeRanges, {
            length: {
              get: function() {
                return 1;
              }
            }
          });

          return timeRanges;
        }
      }
    });
  }

  HTMLYouTubeVideoElement.prototype = new Popcorn._MediaElementProto();
  HTMLYouTubeVideoElement.prototype.constructor = HTMLYouTubeVideoElement;

  // Helper for identifying URLs we know how to play.
  HTMLYouTubeVideoElement.prototype._canPlaySrc = function( url ) {
    return (/(?:http:\/\/www\.|http:\/\/|www\.|\.|^)(youtu)/).test( url ) ?
      "probably" :
      EMPTY_STRING;
  };

  // We'll attempt to support a mime type of video/x-youtube
  HTMLYouTubeVideoElement.prototype.canPlayType = function( type ) {
    return type === "video/x-youtube" ? "probably" : EMPTY_STRING;
  };

  Popcorn.HTMLYouTubeVideoElement = function( id ) {
    return new HTMLYouTubeVideoElement( id );
  };
  Popcorn.HTMLYouTubeVideoElement._canPlaySrc = HTMLYouTubeVideoElement.prototype._canPlaySrc;

}( Popcorn, window, document ));
