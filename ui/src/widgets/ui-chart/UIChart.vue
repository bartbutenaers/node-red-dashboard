<template>
    <div>
       <!--TODO I had to set a random width to avoid the error: [ECharts] Can't get DOM width or height-->
        <div ref="chart" :class="className" style="width: 100%; height: 400px;"/>
    </div>
</template>

<script>
import * as Echarts from 'echarts'
import { shallowRef } from 'vue'
import { mapState } from 'vuex'
import { DateTime } from 'luxon'

export default {
    name: 'DBUIChart',
    inject: ['$socket', '$dataTracker'],
    props: {
        id: { type: String, required: true },
        props: { type: Object, default: () => ({}) }
    },
    data () {
        return {
            /** @type {Chart} */
            chart: null,
            configUpdated: false,
            lastRefreshTime: 0,
            histogram: [], // populate later for bins per series
            chartUpdateDebounceTimeout: null,
            tooltipDataset: []
        }
    },
    computed: {
        ...mapState('data', ['messages']),
        chartType () {
            // Echarts doesn't support Histograms, so we render it as a Bar chart
            if (this.props.chartType === 'histogram') {
                return 'bar'
            }
            return this.props.chartType
        },
        interpolation () {
            return this.props.interpolation
        }
    },
    watch: {
        chartType: function (value) {
            this.chart.config.type = value
            this.update(false)
        },
        'props.label': function (value) {
            this.chart.options.plugins.title.text = value
            this.update(false)
        },
        'props.chartType': function (value) {
            this.chart.config.type = value
            this.updateInteraction(this.chart.config.tooltip)
            this.update(false)
        },
        'props.xAxisType': function (value) {
            this.chart.options.scales.x.type = value
            this.update(false)
        },
        'props.xAxisFormatType': function (value) {
            this.chart.options.scales.x.time.displayFormats = this.getXDisplayFormats(value)
            this.update(false)
        },
        interpolation (value) {
            this.setInterpolation(value)
            this.update(false)
        }
    },
    created () {
        // can't do this in setup as we have custom onInput function
        this.$dataTracker(this.id, this.onMsgInput, this.onLoad)
    },
    mounted () {
        if (window.Cypress) {
            // when testing, we expose the chart object to the window object
            // so we can do an end-to-end test and ensure the right data is applied
            window.uiCharts = window.uiCharts || {}
            window.uiCharts[this.id] = this
        }

        // get a reference to the canvas element
        const el = this.$refs.chart

        const chartOptions = {
            title: {
                text: this.props.label,
            },
            // Let's start without timeseries data, which will added later on
            series: [],
            // Turn off animations to improve performance for large datasets
            // TODO make this adjustable in config screen via a new animationThreshold parameter.
            animation: false,
            // TODO check if this is a good alternative for chartjs borderJoinStyle:'round'
            smooth: true,
            // TODO deze code is met copilot geconverteerd.  Was vroeger een itemSort deel (om voor histogram in dalende orde te sorteren op basis van de y waarde).
            // Daarnaast was er een filter om voor 'histogram' of 'bar' charts de tooltips te verbergen voor lege datapoints (dus y waarde undefined of <=0)
            tooltip: {
                trigger: 'axis',
                formatter: function (params) {
                    let filteredParams = []
                    let seenDatasets = []

                    params.forEach(function (item, index) {
                        if (item.seriesType === 'bar' || item.seriesType === 'line') {
                            if (item.data !== undefined && item.data > 0) {
                                if (seenDatasets.indexOf(item.seriesIndex) === -1) {
                                    seenDatasets.push(item.seriesIndex)
                                    filteredParams.push(item)
                                }
                            }
                        } else {
                            filteredParams.push(item)
                        }
                    })

                    // Sort 'histogram' type if needed (Here we assume 'histogram' type as 'bar')
                    if (params[0].seriesType === 'bar') {
                        filteredParams.sort(function (a, b) {
                            return b.data - a.data
                        })
                    }

                    // Create tooltip content
                    let tooltipContent = ''
                    filteredParams.forEach(function (item) {
                        tooltipContent += item.serieName + ': ' + item.data + '<br/>'
                    })

                    return tooltipContent
                }
                // TODO is heb maintainAspectRatio:false vervangen door width:100% in de style van de div in de template.  Is dat ok om de volledige breedte op te vullen?
            }
        }

        // Do we show the legend?
        let showLegend = this.props.showLegend
        if (this.props.categoryType === 'none') {
            // no category, so no legend
            showLegend = false
        }

        if (showLegend) {
            chartOptions.legend = {
                // TODO echarts zet legende by default in upper right corner
                // orient: 'vertical',
                // right: 10,
                // top: 'center'
                icon: 'rect' // TODO kijken of dit nu ook is met chartjs
            }
        }

        if (this.props.zoomComponent === 'inside' || this.props.zoomComponent === 'slider') {
            chartOptions.dataZoom = [{
                  type: this.props.zoomComponent,
                  filterMode: 'none',
                  // Currently there is only one x-axis to zoom along
                  xAxisIndex: [0]
            }]
        }

        // Customize the x-axis and y-axis, except for chart types that have no axis
        if (this.props.chartType !== 'pie' && this.props.chartType !== 'doughnut') {
            chartOptions.xAxis = {
                name: this.props.xAxisLabel || ''
            }

            // Map the (ChartJs) xAxis types from the config screen to Echarts xAxis types
            switch (this.props.xAxisType) {
                case 'time':
                    chartOptions.xAxis.type = 'time'

                    // Show the timestamp values on the x axis in the specified datetime format
                    chartOptions.xAxis.axisLabel = {
                        // Show the x-axis timestamp values in the specified human readable format
                        formatter: (xAxisValue) => {
                            let format
                            switch (this.props.xAxisFormatType) {
                                case undefined:
                                case '':
                                case 'auto':
                                    // If automatic format or no format (backwards compatibility for older nodes)
                                    format = 'HH:mm:ss'
                                    break
                                case 'custom':
                                    // A custom format has been stored in the typedInput value field
                                    format = this.props.xAxisFormat
                                    break
                                default:
                                    // All other formats are stored in the typedInput type field
                                    format = this.props.xAxisFormatType
                            }

                            // Convert the unix epoch timestamps (in milliseconds) to the specified dateTime format
                            // (which consists out of a series of Luxon tokens).
                            // See https://github.com/moment/luxon/blob/master/docs/formatting.md#table-of-tokens
                            return DateTime.fromMillis(xAxisValue).toFormat(format)
                        }
                    }
                    break
                case 'linear':
                    chartOptions.xAxis.type = 'value'
                    break
                case 'radial':
                    // TODO not supported in Echarts : you might need to use a polar coordinate system
                    chartOptions.xAxis.type = null
                    break
                case 'bins':
                    // Bins are not supported in Echarts, so use 'category' for custom calculations of the histogram categories.
                    // For example bins are categories like ['0-2', '2-4', '4-6', ...]
                    chartOptions.xAxis.type = 'category'
                    chartOptions.xAxis.data = []
                    break
                case 'category':
                    chartOptions.xAxis.type = 'category'
                    chartOptions.xAxis.data = []
                    break
            }

            // TODO this can be an array of multiple y axes
            chartOptions.yAxis = {
                name: this.props.yAxisLabel || '',
                type: 'value'
            }

            if (Object.hasOwn(this.props, 'ymin') && this.props.ymin !== '') {
                chartOptions.yAxis.min = parseFloat(this.props.ymin)
            }
            if (Object.hasOwn(this.props, 'ymax') && this.props.ymax !== '') {
                chartOptions.yAxis.max = parseFloat(this.props.ymax)
            }

            // Override the text color from the Echarts theme, when a custom text color has been specified
            if (this.props.textColor && this.props.textColorDefault === false) {
                let textColor = this.props.textColor[0]

                chartOptions.title.textStyle = {
                    color: textColor
                }

                chartOptions.xAxis.nameTextStyle = chartOptions.yAxis.nameTextStyle = {
                    color: textColor
                }

                chartOptions.xAxis.axisLabel = chartOptions.yAxis.axisLabel = {
                    color: textColor
                }

                chartOptions.xAxis.axisTick = chartOptions.yAxis.axisTick = {
                    lineStyle: {
                        color: textColor
                    }
                }

                if (chartOptions.legend) {
                    chartOptions.legend.textStyle = {
                        color: textColor
                    }
                }
            }

            // Override the grid color from the Echarts theme, when a custom grid color has been specified
            if (this.props.gridColor && this.props.gridColorDefault === false) {
                let gridColor = this.props.gridColor[0]

                chartOptions.xAxis.splitLine = chartOptions.yAxis.splitLine = {
                    lineStyle: {
                        color: gridColor
                    }
                }

                chartOptions.xAxis.axisLine = chartOptions.yAxis.axisLine = {
                    lineStyle: {
                        color: gridColor
                    }
                }
            }
        }

        // Create the Echarts instance
        const chart = Echarts.init(el)
        chart.setOption(chartOptions)

        // Useful for debugging: uncomment to expose the chart object to the window
        // window.uiChart = window.uiChart || {}
        // window.uiChart[this.id] = chart

        // don't want chart to be reactive, so we can use shallowRef
        this.chart = shallowRef(chart)

        // ensure the chart is updated with the correct interaction mode
        // based on the type of chart we are creating
        this.updateInteraction(chartOptions.tooltip)
    },
    methods: {
        updateInteraction (tooltip) {
            // In Echarts every series can have a different chart type (line, bar, ...).  However the interaction is global,
            // which means the same for all the series that are being displayed together.
            // Currently this node only supports a single chart type, which will be used for all the series.
            // But that might change in the future, and then this logic will need to be refactored...
            switch (this.chartType) {
                case 'line':
                    // Tooltip should display info for all data points on that specific (x) axis line
                    tooltip.trigger = 'axis'
                    // The axis point needs to be a line that follows the X-axis, to see the alignment of data points along that axis more clearly
                    tooltip.axisPointer = {
                        type: 'line',
                        axis: 'x'
                    }
                break

                case 'scatter':
                    // Trigger a tooltip for the (nearest) item, so no axis pointer needed
                    tooltip.trigger = 'item'
                    tooltip.axisPointer = {
                        type: 'none'
                    }
                break

                default:
                    tooltip.trigger = 'axis'
                    // Set the axis pointer to a shadow type, which highlights the entire region along the X-axis (to visualize the interaction area)
                    tooltip.axisPointer = {
                        type: 'shadow',
                        axis: 'x'
                    }
                break
            }

            // Update the tooltip options in the chart instance
            // TODO this is not the correct way to set the tooltip
            // TODO moet hier een volledige setoption opgeroepen worden?
            this.chart.setOption({
                tooltip: tooltip
            })
        },
        update (immediate = true) {
            // for data adding, we want to update immediately
            // but in some cases, like updating multiple props, we want to debounce
            if (immediate) {
                if (this.chartUpdateDebounceTimeout) {
                    clearTimeout(this.chartUpdateDebounceTimeout)
                    this.chartUpdateDebounceTimeout = null
                }
        // TODO followin copilot the Echarts alternative for update() is setOption()
                this.chart.update()
                return
            }
            if (this.chartUpdateDebounceTimeout) {
                return
            }
            this.chartUpdateDebounceTimeout = setTimeout(() => {
                try {
                    this.chart.update()
                } finally {
                    this.chartUpdateDebounceTimeout = null
                }
            }, 30)
        },
        // given an object, return the value of the category property (which can be nested)
        getLabel (value, category) {
            if (this.props.categoryType !== 'property') {
                return category
            }
            // get nested property value
            if (category) {
                const props = category.split('.')
                props.forEach((prop) => {
                    if (value) {
                        value = value[prop]
                    }
                })
            }
            return value
        },
        onLoad (history) {
            if (history && history.length > 0) {
                // we have received a history of data points
                // we need to add them to the chart
                // clear the chart first, onload is considered to provide all data into a chart
                this.clearChart()
                // adding is then just the same process as receiving a new msg
                this.onMsgInput(history)
            }
        },
        onMsgInput (msg) {
            if (Array.isArray(msg.payload) && !msg.payload.length) {
                // Clear the chart, when the payload contains an empty array
                this.clearChart()
            } else {
                if (msg.action === 'replace' || (this.props.action === 'replace' && msg.action !== 'append')) {
                    // Clear the chart, when the data(points) needs to be replaced (instead of appended)
                    this.clearChart()
                }

                this.updateChart(msg)
            }
        },
        clearChart () {
            if (this.chart) {
                let chartOptions = this.chart.getOption()
                chartOptions.series = []
                chartOptions.xAxis[0].data = []
                this.chart.setOption(chartOptions, true)
            }

            if (this.refreshTimer) {
                clearTimeout(this.refreshTimer)
                this.refreshTimer = null
            }
        },
        updateChart (msg) {
            // Get the current chart options, which contains both the config and data(points).
            // Note: although at the start we specified one xAxis and one yAxis (both as an object), Echarts automatically converts
            // them to an array containing one object.  As long as we have only one axis, we just get the first xAxis everywhere in the code....
            let chartOptions = this.chart.getOption()

            // Delete the custom properties from the series (which might be stored there since the previous run)
            chartOptions.series.forEach(serie => {
                delete serie.isNew
                delete serie.appendStartIndex
            })

            // The msg.payload contains the original payload, while the msg._datapoint contains the mapped payload.
            // The payload mapping happens on the server-side when the msg is being injected.
            // The msg._datapoint contains the mapped properties 'x', 'y' and 'category'

            if (Array.isArray(msg) && msg.length > 0) {
                // We have received an array of messages (loading from stored history)
                msg.forEach((m, i) => {
                    if (m._datapoint) {
                        this.addDataPoints(chartOptions, m.payload, m._datapoint)
                    }
                })
            } else if (Array.isArray(msg.payload) && msg.payload.length > 0) {
                if (msg.payload.length === msg._datapoint.length) {
                    // We have received a message, whose payload contains an array of data points (and should append each of them)
                    msg.payload.forEach((p, i) => {
                        this.addDataPoints(chartOptions, p, msg._datapoint[i])
                    })
                }
            } else if (msg.payload !== null && msg.payload !== undefined) {
                if (msg._datapoint) {
                    // we have a single payload value and should append it to the chart
                    this.addDataPoints(chartOptions, msg.payload, msg._datapoint)
                }
            } else {
                console.log('The message contains no payload')
            }

            // After all data(points) have been added, it might be necessary to remove some of the oldest datapoints
            if (this.chartType === 'line' || this.chartType === 'scatter') {
                this.limitDataSize(chartOptions)
            }

            // For line/scatter charts, Echarts allows to append fast data(points) to EXISTING series.  
            // When only one or few datapoints are being added, that mechanism is much faster compared to
            // passing the points via setOption (because then Echarts need to compare ALL data to calculate the delta)
            let existingSeries = []
            if (this.chartType === 'line' || this.chartType === 'scatter') {
                let newSeries = chartOptions.series.filter(serie => serie.isNew === true)

                if (newSeries.length === 0) {
                    existingSeries = chartOptions.series
                    chartOptions.series = []
                }
            }

            // It is useless (and bad for performance) to pass the chart options to Echarts, when it doesn't contains any series
            // TODO wordt dit niet altijd uitgevoerd??????????????????
            if (chartOptions.series.length > 0) {
                console.log("Calling setOption")
                // Update the chart options, which might contains both updated config and/or updated data(points).
                // All the updates are applied to the chart at once, to improve performance.
                // TODO shouldn't the commit need to happen here once, instead of for every datapoint in the addDataPoints function?
                // Because that seems horrible slow to me.  But I have no idea anymore how the whole commit stuff works.
                this.chart.setOption(chartOptions)
                //console.log("called setOption" + JSON.stringify(chartOptions))
            }

            if (existingSeries.length > 0) {
                existingSeries.forEach((serie, index) => {
                    if (serie.hasOwnProperty('appendStartIndex')) {
                        let newDatapoints = serie.data.slice(serie.appendStartIndex)
                        if (newDatapoints.length > 0) {
                            let data = {
                                seriesIndex: index,
                                // Data is two dimensional array of datapoints [[x1,y1], [x2,y2], ...]
                                data: newDatapoints
                            }

                            // Append the new data(points) at once to the existing series
                            this.chart.appendData(data)
                            //console.log("appended " + JSON.stringify(data))
                        }
                    }
                })

                // When appending datapoints, these will only be rendered when requested explicit.
                // See https://github.com/apache/echarts/issues/20734
                // When datapoints arrive at high speed, it is only useful to refresh the chart at the
                // specified time interval (as long as the datapoints keep arriving)
                const refreshInterval = parseInt(this.props.refreshInterval)
                if (refreshInterval > 0) {
                    const now = Date.now()
                    console.log(now + ' - ' + this.lastRefreshTime + ' = ' + (now - this.lastRefreshTime))
                    // Check if the specified time interval has been exceeded
                    if (now - this.lastRefreshTime >= refreshInterval) {
                        console.log("resize chart started")
                        this.chart.resize() // Re-render the chart
                        console.log("resize chart ended")
                        this.lastRefreshTime = now
                    }

                    if (this.refreshTimer) {
                        clearTimeout(this.refreshTimer)
                        this.refreshTimer = null
                    }

                    // Set a new timeout to refresh the chart if no new data points arrive within the specified interval
                    this.refreshTimer = setTimeout(() => {
                        console.log('timer resize chart started')
                        this.chart.resize() // Re-render the chart
                        console.log('timer resize chart ended')
                        this.refreshTimer = null
                        this.lastRefreshTime = now
                    }, refreshInterval)
                } else {
                    // Refresh automatically
                    console.log("resized immediate")
                    this.chart.resize() // Re-render the chart
                }
            }
        },
        addDataPoints (chartOptions, payload, datapoint) {
            // The data should contain both the dataPoint and the payload, wich means both the original and mapped properties:
            // {
            //     xOriginal: xxx,
            //     yOriginal: yyy,
            //     categoryOriginal: zzz,
            //     x: xxx,
            //     y: yyy,
            //     category: zzz
            // }
            const data = { ...datapoint, ...payload }

            if (Array.isArray(datapoint.category) && datapoint.category.length > 0) {
                // we have an array of series, meaning we plot multiple data points per data object
                for (let i = 0; i < datapoint.category.length; i++) {
                    const clonedData = {
                        ...d
                    }
                    clonedData.category = datapoint.category[i]
                    clonedData.y = datapoint.y[i]
                    this.addDataPoint(chartOptions, clonedData, datapoint.category[i])
                    this.commit(payload, clonedData, datapoint.category[i])
                }
            } else {
                this.addDataPoint(chartOptions, data, datapoint.category)
                this.commit(payload, datapoint, datapoint.category)
            }
        },
        addDataPoint (chartOptions, datapoint, serieName) {
            // Try to find the serie the new datapoint belongs to
            let serie = chartOptions.series.find(s => s.name === serieName)

            if (!serie) {
                // If there exists no serie with that name yet, create one and add it to the chart
                serie = this.createNewSerie(chartOptions, serieName)
            }

            switch(this.props.chartType) {
            case 'histogram':
                let binIndex
                switch (this.props.xAxisType) {
                case 'bins':
                    // The datapoint x values are continuous, but they are displayed discontinous in the chart x-axis as bins.
                    // These bins categories have been calculated before, based on the bin settings in the config screen 
                    // (e.g. ['0-5', '5-10', ...]).  For each bin count how many datapoints belong to that bin, i.e. how many
                    // datapoints have an x value that fits into the bin range:
                    // chartOptions = {
                    //        xAxis: {
                    //            data: ['0-5', '5-10', '10-15', '15-20', '20-25']
                    //        },
                    //        yAxis: {},
                    //        series: [{
                    //            data: [10, 22, 28, 23, 19],
                    //            type: 'bar',
                    //        }]
                    //    }

                    // Based on the datapoint x value, determine to which bin (index) that value belongs.
                    // Note: when a datapoint x value exceeds the upper limit (specified in the config screen),
                    // that datapoint will end up in the last bin...
                    const binSize = Math.floor((this.props.xmax - this.props.xmin) / this.props.bins)
                    binIndex = Math.min(Math.floor((datapoint.x - this.props.xmin) / binSize), chartOptions.xAxis[0].data.length - 1)
                    break
                case 'category':
                    // The datapoint x-axis values are discontinuous, i.e. the values are categories.
                    // For each category, count how many datapoints belong to that category:
                    // chartOptions = {
                    //        xAxis: {
                    //            data: ['A', 'B', 'C', 'D', 'E']
                    //        },
                    //        yAxis: {},
                    //        series: [{
                    //            data: [10, 22, 28, 23, 19],
                    //            type: 'bar',
                    //        }]
                    //    }

                    // When the serie has less values as the number of x-Axis categories, add some 0 values to fix it.
                    // This might happen when:
                    //   - A value has been appended to another series for a new category.
                    //   - A value for a new serie is specifed (and that new serie contains no datapoints yet)
                    while (serie.data.length < chartOptions.xAxis[0].data.length) {
                        serie.data.push(0)
                    }

                    // Based on the datapoint x category, determine to which bin (index) that value belongs.
                    binIndex = chartOptions.xAxis[0].data.indexOf(datapoint.x)

                    // The bin (for the specified category) might need to be created (with initial count 1), because the data has arrived in an awkward order.
                    if (binIndex === -1) {
                        // TODO is it ok to add this bin at the end?  E.g. if the bin category is the month ('Jan', 'Feb', ...) they might end up ordered incorrectly
                        chartOptions.xAxis[0].data.push(datapoint.x)
                        serie.data.push(1)
                    }
                    break
                }

                // Increment the selected bin value.
                // This is the key difference between a bar chart and a histogram, although both have x-Axist type 'category':
                //    - In a bar chart the datapoint's y value will be stored in the category.
                //    - In a histogram the category value will be incremented.
                serie.data[binIndex]++
                break
            case 'pie':
                // chartOptions = {
                //    series: [{
                //        radius: '50%',
                //        data: [
                //            { value: 1048, name: 'Search Engine' },
                //            { value: 735, name: 'Direct' },
                //            { value: 580, name: 'Email' },
                //            { value: 484, name: 'Union Ads' },
                //            { value: 300, name: 'Video Ads' }
                //        ]
                //    ]
                // }
                serie.radius = (this.props.outerRadius || 75) + '%'
                serie.data.push({
                    name: datapoint.x,
                    value: datapoint.y
                })
                break
            case 'doughnut':
            // Echarts doesn't know the doughnut chart type.
            // A doughnut chart is a pie chart with radius = [innerRadius, outerRadius].
                serie.radius = [(this.props.innerRadius || 50) + '%', (this.props.outerRadius || 75) + '%']
                serie.data.push({
                    name: datapoint.x,
                    value: datapoint.y
                })
                break
            case 'bar':   //if (this.props.xAxisType === 'category' ) {
                // The chart x-axis can be discontinuous, which means only a selection of values are possible:
                // chartOptions = {
                //        xAxis: {
                //            data: ['A', 'B', 'C', 'D', 'E']
                //        },
                //        yAxis: {},
                //        series: [{
                //            data: [10, 22, 28, 23, 19],
                //            type: 'line',
                //        }]
                //    }

                // Although at the start we specified one xAxis and one yAxis (both as an object), Echarts automatically converts
                // them to an array containing one object.  As long as we have only one axis, we can just get the first one here.
                let xIndex = chartOptions.xAxis[0].data.indexOf(datapoint.x)
                if (xIndex < 0) {
                    // When the category doesn't exist yet, add a new category to the x-axis
                    xIndex = chartOptions.xAxis[0].data.push(datapoint.x) - 1
                }

                // Update the y-axis value of the category
                serie.data[xIndex] = datapoint.y
                break
            case 'line':
            case 'scatter':
                // The chart x-axis can be continious, which means every value is possible:
                // chartOptions = {
                //        xAxis: {},
                //        yAxis: {},
                //        series: [ {
                //            data: [ [20, 120], [50, 200], [40, 50] ],
                //            type: 'line'
                //        }]
                //   }

                // Remember (in a custom property of the serie) the index where we started adding new datapoints
                serie.appendStartIndex = serie.appendStartIndex || serie.data.length

                // Add a sub-array to the array for the new datapoint
                // TODO moeten we controleren of dat punt al bestaat (zoals net hierboven) EN mogen we dat appenden of ergens inserten (zodat x waarden in volgorde liggen)
                serie.data.push([datapoint.x, datapoint.y])
                break
            }
        },
        // TODO dit is een nieuwe functie met copilot gemaakt
        createNewSerie (chartOptions, serieName) {
            // This new series will be appended at the end of the list
            const index = chartOptions.series.length

            // if we have no serie with that name yet, then can color each bar/x a different value, or if it's a radial chart
            // TODO is dit correct??
            const colorByIndex = (this.props.categoryType === 'none' && this.chartType === 'bar') || this.props.xAxisType === 'radial'

            // Echarts use type 'pie' also to show a 'doughnut' chart.
            // TODO For a pie chart one radius needs to be specified, and for a doughnut chart two radius.
            let type = this.props.chartType === 'doughnut' ? 'pie' : this.props.chartType

            let newSerie = {
                type: type,
                name: serieName,
                data: [],
                // Echarts uses 'x' and 'y' as the default property names, where the x and y values are expected
                encode : {
                    x: 'x',
                    y: 'y',
                    tooltip: ['x', 'y']
                },
                // Add a custom property (used in this node only but not by Echarts), to specify that it is a new serie
                isNew: true
            }

            switch (this.props.chartType) {
            case 'pie':
            case 'doughnut':
                // It is possible to specify the color for each datapoint in the series, i.e. each pie slice:
                // data: [{
                //     value: 335,
                //     name: 'Direct',
                //     itemStyle: {
                //        color: '#ff7f50' // Color for this specific data item
                //     }
                // },...]
                // We will instead apply a color array, and Echarts applies those colors to the data elements sequentially.
                newSerie.color = this.props.colors
                break
            case 'histogram':
                // TODO dat staat nog elders boven waar dat dan weg mag
                // Echarts doesn't support histogram out-of-the-box, so use a bar chart instead
                newSerie.type = 'bar'

                switch (this.props.xAxisType) {
                case 'bins':
                    // Calculate the bins based on the bin settings in the config screen, and store them in the chart
                    // options (with initial count 0):
                    // chartOptions = {
                    //        xAxis: {
                    //            data: ['0-5', '5-10', '10-15', '15-20', '20-25']
                    //        },
                    //        series: [{
                    //            data: [10, 22, 28, 23, 19],
                    //            type: 'bar',
                    //        }]
                    //    }
                    const minX = this.props.xmin || 0
                    const maxX = this.props.xmax || 100
                    const numBins = this.props.bins || 10
                    const binSize = (maxX - minX) / numBins

                    for (let i = 0; i < numBins; i++) {
                        const min = minX + (i * binSize)
                        const max = minX + ((i + 1) * binSize)
                        chartOptions.xAxis[0].data.push(`${min}-${max}`)
                        newSerie.data.push(0)
                    }
                    break
                case 'categorie':
                    // In this case there will be one bin per category.
                    // Currently no bin categories can be specified in the config screen, but instead the bin categories
                    // will arrive as the datapoint x values (and added on the fly to the chart).
                    // So don't add here any categories to chartOptions.xAxis[0].data yet...
                    break
                }
                break
            case 'bar':
                break
            case 'line':
                // TODO kijken wat colorByindex=yes doet??
                // Apply the specified n-th color (at the specified index) 
                let backgroundColor = colorByIndex 
                    ? this.props.colors 
                    : this.props.colors[index % this.props.colors.length]

                newSerie.itemStyle = {
                    color: backgroundColor
                }

                newSerie.emphasis = {
                    itemStyle: {
                        color: backgroundColor
                    }
                }

                switch (this.props.interpolation) {
                case 'cubic':
                    // TODO is this correct??
                    newSerie.smooth = true
                    newSerie.smoothMonotone = null
                    break
                case 'cubicMono':
                    // TODO is this correct??
                    newSerie.smooth = true
                    newSerie.smoothMonotone = 'x'
                    break
                case 'linear':
                    newSerie.smooth = false
                    break
                case 'bezier':
                    newSerie.smooth = true
                    break
                case 'step':
                    newSerie.step = 'end' // Note that also 'middle' or 'start' are possible
                    break
                }

                // TODO Not all former ChartJs point shapes are available in Echarts.  Echarts support these:
                //    'circle', 'rect'(rectangle), 'roundRect'(rounded rectangle), 'triangle', 'diamond', 'pin' and 'arrow'
                // Convert the ones that exist, and add a custom SVG drawing for the ones that don't exist.
                // TODO de SVG strings van copilot werken niet.  Wachten op feedback: zie Echarts discussie op github in originele migratie ticket
                let symbol
                switch (this.props.pointShape) {
                    case 'circle':
                        symbol = 'circle'
                        break
                    case 'cross':
                        symbol = 'path://M -4,0 L 4,0 M 0,-4 L 0,4'
                        break;
                    case 'crossRot':
                        symbol = 'path://M -4,-4 L 4,4 M 4,-4 L -4,4'
                        break
                    case 'dash':
                        symbol = 'path://M -4,0 L 4,0 Z'
                        break
                    case 'line':
                        symbol = 'path://M -4,0 L 4,0 Z'
                        break
                    case 'rect':
                        symbol = 'rect'
                        break
                    case 'rectRounded':
                        symbol = 'roundRect'
                        break
                    case 'rectRot':
                        symbol = 'path://M -4,-4 L 4,0 L 0,4 L -4,0 Z'
                        break
                    case 'star':
                        symbol = 'star'
                        break
                    case 'triangle':
                        symbol = 'triangle'
                        break
                    case 'false':
                        // No symbol needed
                }

                if (symbol) {
                    newSerie.showSymbol = true
                    newSerie.symbol = symbol
                    newSerie.symbolSize = this.props.pointRadius ? this.props.pointRadius : 4
                }
                else {
                    newSerie.showSymbol = false
                }

                if (!colorByIndex) {
                    newSerie.lineStyle = {
                        color: this.props.colors[index]
                    }
                }
                break
            }

            if (this.props.stackSeries === true) {
                // Use the same stack name for all the series, to stack this new series on top of the previous series
                newSerie.stack = 'total'
            }

            // Store the new serie in the chart options
            chartOptions.series.push(newSerie)

            return newSerie
        },
        limitDataSize(chartOptions) {
            let cutoff = null
            let points = null

            if (this.props.xAxisType === 'time' && this.props.removeOlder && this.props.removeOlderUnit) {
                const removeOlder = parseFloat(this.props.removeOlder)
                const removeOlderUnit = parseFloat(this.props.removeOlderUnit)
                const ago = (removeOlder * removeOlderUnit) * 1000 // milliseconds ago
                cutoff = (new Date()).getTime() - ago
            }

            if (this.props.removeOlderPoints) {
                points = parseInt(this.props.removeOlderPoints)
            }

            // Apply data limitations to the ECharts series
            if ((cutoff || points) && chartOptions.series.length > 0) {
                for (let i = 0; i < chartOptions.series.length; i++) {
                    const originalLength = chartOptions.series[i].data.length
                    // TODO check whether slicing is much faster
                    chartOptions.series[i].data = chartOptions.series[i].data.filter((d, i) => {
                        const timestamp = new Date(d[0]).getTime()
                        if (cutoff && timestamp < cutoff) {
                            return false
                        } else if (points && (i < originalLength - points)) {
                            return false
                        }
                        return true
                    })

                    // If the first N items have been removed from the array, then the appendStartIndex should be moved
                    const newLength = chartOptions.series[i].data.length
                    const diff = originalLength - newLength
                    chartOptions.series[i].appendStartIndex = chartOptions.series[i].appendStartIndex - diff
                }
            }
// TODO moet dit niet in de bovenliggende functie (eenmalig) gebeuren?????????
            // apply data limtations to the vuex store
            this.$store.commit('data/restrict', {
                widgetId: this.id,
                min: cutoff,
                points
            })
        },
        commit (payload, datapoint, serieName) {
            // APPEND our latest data point to the store
            this.$store.commit('data/append', {
                widgetId: this.id,
                msg: {
                    payload,
                    _datapoint: datapoint,
                    series: serieName
                }
            })
        }
    }
}
</script>

<style scoped>
.nrdb-ui-chart-placeholder {
    position: absolute;
    display: flex;
    justify-content: center;
    align-items: center;
    top: 0;
    width: 100%;
    height: 100%;
    color: rgba(var(--v-theme-on-group-background), var(--v-disabled-opacity));
    --pie-slice-1: rgba(var(--v-theme-on-group-background), 0.05);
    --pie-slice-2: rgba(var(--v-theme-on-group-background), 0.1);
    background: radial-gradient(circle closest-side, rgb(var(--v-theme-group-background)) 50%, transparent 0),
        radial-gradient(circle closest-side, transparent 66%, rgb(var(--v-theme-group-background)) 0),
        conic-gradient(var(--pie-slice-1) 0, var(--pie-slice-1) 38%, var(--pie-slice-2) 0, var(--pie-slice-2) 61%);
}
</style>
