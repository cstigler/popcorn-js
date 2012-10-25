(function( Popcorn, window, document ) {

  var

  CURRENT_TIME_MONITOR_MS = 10,
  EMPTY_STRING = "",

  // Flowplayer suggests 200x200 as minimum, video spec says 300x150.
  MIN_WIDTH = 300,
  MIN_HEIGHT = 200,

  // Example: http://www.Flowplayer.com/watch?v=12345678901
  regexFlowplayer = /^.*(?:\/|v=)(.{11})/,

  ABS = Math.abs,

  // Setup for Flowplayer API
  ytReady = false,
  ytLoaded = false,
  ytCallbacks = [];

  // function isFlowplayerReady() {
  //   // If the Flowplayer iframe API isn't injected, to it now.
  //   if( !ytLoaded ) {
  //     var tag = document.createElement( "script" );
  //     var protocol = window.location.protocol === "file:" ? "http:" : "";
  // 
  //     tag.src = protocol + "//www.Flowplayer.com/iframe_api";
  //     var firstScriptTag = document.getElementsByTagName( "script" )[ 0 ];
  //     firstScriptTag.parentNode.insertBefore( tag, firstScriptTag );
  //     ytLoaded = true;
  //   }
  //   return ytReady;
  // }
  // 
  // function addFlowplayerCallback( callback ) {
  //   ytCallbacks.unshift( callback );
  // }

  // An existing Flowplayer references can break us.
  // Remove it and use the one we can trust.
  // if ( window.YT ) {
  //   window.quarantineYT = window.YT;
  //   window.YT = null;
  // }
  // 
  // window.onFlowplayerIframeAPIReady = function() {
  //   ytReady = true;
  //   var i = ytCallbacks.length;
  //   while( i-- ) {
  //     ytCallbacks[ i ]();
  //     delete ytCallbacks[ i ];
  //   }
  // };

  function HTMLFlowplayerVideoElement( id ) {
    // Flowplayer iframe API requires postMessage
    if( !window.postMessage ) {
      throw "ERROR: HTMLFlowplayerVideoElement requires window.postMessage";
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
      metadataReadyCallbacks = [],
      playerState = -1,
      stateMonitors = {},
      stateMonitorTimeout,
      updateDurationTimeout,
      bufferedInterval,
      lastLoadedFraction = 0,
      currentTimeInterval,
      lastCurrentTime = 0,
      seekTarget = -1,
      timeUpdateInterval,
      forcedLoadMetadata = false;

    // Namespace all events we'll produce
    self._eventNamespace = Popcorn.guid( "HTMLFlowplayerVideoElement::" );

    self.parentNode = parent;

    // Mark this as Flowplayer
    self._util.type = "Flowplayer";

    function addPlayerReadyCallback( callback ) {
      if ( playerReadyCallbacks.indexOf( callback ) < 0 ) {
        playerReadyCallbacks.unshift( callback );
      }
    }

    function addMetadataReadyCallback( callback ) {
      if ( metadataReadyCallbacks.indexOf( callback ) < 0 ) {
        metadataReadyCallbacks.unshift( callback );
      }
    }

    function onPlayerReady( event ) {
      if ( player === event.target ) {
        playerReady = true;
        while( playerReadyCallbacks.length ) {
          fn = playerReadyCallbacks.pop();
          fn();
        }
      }
    }

    // Flowplayer sometimes sends a duration of 0.  From the docs:
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
        addPlayerReadyCallback( getDuration );
        return impl.duration;
      }

      var oldDuration = impl.duration,
          newDuration = player.getDuration();

      // Deal with duration=0 from Flowplayer
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
      // There's no perfect mapping to HTML5 errors from Flowplayer errors.
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
      function updateDuration() {
        var fn;

        if ( !impl.readyState && playerReady && getDuration() ) {
          // XXX: this should really live in cued below, but doesn't work.
          impl.readyState = self.HAVE_METADATA;
          self.dispatchEvent( "loadedmetadata" );
          bufferedInterval = setInterval( monitorBuffered, 50 );

          while( metadataReadyCallbacks.length ) {
            fn = metadataReadyCallbacks.pop();
            fn();
          }

          self.dispatchEvent( "loadeddata" );

          impl.readyState = self.HAVE_FUTURE_DATA;
          self.dispatchEvent( "canplay" );

          // We can't easily determine canplaythrough, but will send anyway.
          impl.readyState = self.HAVE_ENOUGH_DATA;
          self.dispatchEvent( "canplaythrough" );

          // Auto-start if necessary
          if( impl.autoplay ) {
            self.play();
          }
          return;
        }

        if (!updateDurationTimeout) {
          updateDurationTimeout = setTimeout( updateDuration, 50 );
        }
      }

      updateDuration();

      switch( event.data ) {
        // ended
        case YT.PlayerState.ENDED:
          onEnded();
          break;

        // playing
        case YT.PlayerState.PLAYING:
          onPlay();
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
          // XXX: cued doesn't seem to fire reliably, bug in Flowplayer api?
          break;
      }
      if (event.data !== YT.PlayerState.BUFFERING && playerState === YT.PlayerState.BUFFERING) {
        onProgress();
      }

      playerState = event.data;
    }

    function onPlaybackQualityChange ( event ) {
      self.dispatchEvent( "playbackqualitychange" );
    }

    function destroyPlayer() {
      if( !( playerReady && player ) ) {
        return;
      }
      clearInterval( currentTimeInterval );
      clearInterval( bufferedInterval );
      clearTimeout( stateMonitorTimeout );
      clearTimeout( updateDurationTimeout );
      Popcorn.forEach( stateMonitors, function(obj, i) {
        delete stateMonitors[i];
      });

      player.stopVideo();
      if ( player.clearVideo ) {
        player.clearVideo();
      }

      if ( elem && elem.parentNode ) {
        elem.parentNode.removeChild( elem );
      }
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

      elem = document.createElement( "div" );
      elem.className += " flowplayer";
      elem.width = impl.width;
      elem.height = impl.height;
      
      var video = document.createElement( "video" );
      video.src = aSrc;
      
      elem.appendChild( video );
      
      parent.appendChild( elem );

      player = flowplayer ( elem );

      impl.networkState = self.NETWORK_LOADING;
      self.dispatchEvent( "loadstart" );
      self.dispatchEvent( "progress" );
    }

    function getCurrentTime() {
      if( !player || !player.video ) {
        return 0;
      }
      
      impl.currentTime = player.video.time;

      return impl.currentTime;
    }

    function changeCurrentTime( aTime ) {
      if( !player ) {
        addPlayerReadyCallback( function() { changeCurrentTime( aTime ); } );
        return;
      }

      player.seek( aTime );
    }

    function onTimeUpdate() {
      self.dispatchEvent( "timeupdate" );
    }

    function onSeeking( target ) {
      impl.seeking = true;
      self.dispatchEvent( "seeking" );
    }

    function onSeeked() {
      impl.seeking = false;
      self.dispatchEvent( "timeupdate" );
      self.dispatchEvent( "seeked" );
    }

    function onPlay() {
      if(impl.)
        // Only 1 play when video.loop=true
        if ( !impl.loop ) {
          self.dispatchEvent( "play" );
        }
        self.dispatchEvent( "playing" );
      }
    }

    function onProgress() {
      self.dispatchEvent( "progress" );
    }

    self.play = function() {
      if( !playerReady ) {
        addMetadataReadyCallback( function() { self.play(); } );
        return;
      }
      player.playVideo();
    };

    function onPause() {
      impl.paused = true;
      clearInterval( timeUpdateInterval );
      self.dispatchEvent( "pause" );
    }

    self.pause = function() {
      if( !playerReady ) {
        addMetadataReadyCallback( function() { self.pause(); } );
        return;
      }
      player.pauseVideo();
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
        addMetadataReadyCallback( function() {
          setVolume( impl.volume );
        });
        return;
      }
      changeState( "getVolume", player.getVolume(), "volumechange" );
      player.setVolume( aValue );
    }

    function getVolume() {
      if( !playerReady ) {
        return impl.volume > -1 ? impl.volume : 1;
      }
      return player.getVolume();
    }

    function setMuted( aValue ) {
      impl.muted = aValue;
      if( !playerReady ) {
        addMetadataReadyCallback( function() { setMuted( impl.muted ); } );
        return;
      }
      changeState( "isMuted", player.isMuted(), "volumechange" );
      player[ aValue ? "mute" : "unMute" ]();
    }

    function getMuted() {
      // Flowplayer has isMuted(), but for sync access we use impl.muted
      return impl.muted;
    }

    function updateSize() {
      player.setSize( impl.width, impl.height );
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
          return elem ? elem.width : impl.width || 0;
        },
        set: function( aValue ) {
          impl.width = aValue;
          if (elem) {
            elem.width = aValue;
          }

          if( playerReady ) {
              player.setSize( impl.width, impl.height );
          } else {
              addPlayerReadyCallback( updateSize );
          }
        }
      },

      height: {
        get: function() {
          return elem ? elem.height : impl.height || 0;
        },
        set: function( aValue ) {
          impl.height = aValue;
          if (elem) {
            elem.height = aValue;
          }

          if( playerReady ) {
              player.setSize( impl.width, impl.height );
          } else {
              addPlayerReadyCallback( updateSize );
          }
        }
      },

      currentTime: {
        get: function() {
          return getCurrentTime();
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
          // Remap from HTML5's 0-1 to Flowplayer's 0-100 range
          var volume = getVolume();
          return volume / 100;
        },
        set: function( aValue ) {
          if( aValue < 0 || aValue > 1 ) {
            throw "Volume value must be between 0.0 and 1.0";
          }

          // Remap from HTML5's 0-1 to Flowplayer's 0-100 range
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

    self._util.getPlaybackQuality = function() {
      return playerReady && player.getPlaybackQuality() || impl.quality || 'default';
    };

    self._util.setPlaybackQuality = function( quality ) {
      impl.quality = quality;

      if( !playerReady ) {
        addMetadataReadyCallback( function() {
          player.setPlaybackQuality( impl.quality );
        });
        return;
      }

      player.setPlaybackQuality( quality );
    };

    self._util.getAvailableQualityLevels = function() {
      return playerReady && player.getAvailableQualityLevels() || [];
    };

  }

  HTMLFlowplayerVideoElement.prototype = new Popcorn._MediaElementProto();
  HTMLFlowplayerVideoElement.prototype.constructor = HTMLFlowplayerVideoElement;

  // Helper for identifying URLs we know how to play.
  HTMLFlowplayerVideoElement.prototype._canPlaySrc = function( url ) {
    return 'maybe';
  };

  // We'll attempt to support a mime type of video/x-Flowplayer
  HTMLFlowplayerVideoElement.prototype.canPlayType = function( type ) {
    return type === "video/x-Flowplayer" ? "probably" : EMPTY_STRING;
  };

  Popcorn.HTMLFlowplayerVideoElement = function( id ) {
    return new HTMLFlowplayerVideoElement( id );
  };
  Popcorn.HTMLFlowplayerVideoElement._canPlaySrc = HTMLFlowplayerVideoElement.prototype._canPlaySrc;

}( Popcorn, window, document ));
